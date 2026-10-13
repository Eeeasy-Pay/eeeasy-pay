import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPersistenceStores } from '@eeeasy-pay/persistence';
import type { PersistenceStores } from '@eeeasy-pay/persistence';
import { deterministicId, seedQuotedIntent, seedUser } from '@eeeasy-pay/persistence/int-helpers';
import { canonicalize, sha256Hex } from '@eeeasy-pay/pal';
import { SimulatorSponsorDfspConnector } from '@eeeasy-pay/sponsor-dfsp-connector';
import type { Clock } from '@eeeasy-pay/ports';
import { OutboxWorker } from './processor.ts';

// Integration tests against a disposable Postgres database (TEST_DATABASE_URL) with
// ci/db/prepare.sql and all supabase/migrations applied. Never a real or shared
// environment (docs/implementation/GUARDRAILS.md).

const databaseUrl = process.env.TEST_DATABASE_URL;

const maybeDescribe = databaseUrl ? describe : describe.skip;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const pool = new Pool(databaseUrl ? { connectionString: databaseUrl } : {});
const stores: PersistenceStores = createPersistenceStores(pool);

const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

interface SeededConfirmation {
  readonly paymentIntentId: string;
  readonly quoteId: string;
}

/** Seeds a quoted intent and confirms it, producing the durable submit_payment command. */
async function confirmedIntent(ref: string): Promise<SeededConfirmation> {
  const userId = deterministicId('user', ref);
  await seedUser(stores.db, userId);
  const seeded = await seedQuotedIntent(stores.db, stores, { userId, ref });
  const outcome = await stores.commands.confirmPaymentIntent({
    actorId: seeded.userId,
    paymentIntentId: seeded.paymentIntentId,
    quoteId: seeded.quoteId,
    quoteBindingDigest: seeded.bindingDigest,
    requestDigest: sha256Hex(canonicalize({ ref })),
    idempotencyKeyDigest: sha256Hex('confirm:' + ref),
    authorizationEvidenceRef: 'sim-authorization-evidence',
    correlationId: deterministicId('correlation', ref),
  });
  expect(outcome.state).toBe('user_authorized');
  return { paymentIntentId: seeded.paymentIntentId, quoteId: seeded.quoteId };
}

interface OutboxRowView {
  outbox_message_id: string;
  command_type: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
}

async function outboxRow(paymentIntentId: string): Promise<OutboxRowView | null> {
  const result = await stores.db.query<OutboxRowView>(
    `SELECT outbox_message_id, command_type, state, attempts, last_error_code
       FROM public.outbox_messages
      WHERE aggregate_id = $1`,
    [paymentIntentId],
  );
  return result.rows[0] ?? null;
}

interface EventRowView {
  event_type: string;
  source_system: string;
  external_event_id: string | null;
  safe_metadata: Record<string, unknown>;
}

async function eventsFor(paymentIntentId: string): Promise<EventRowView[]> {
  const result = await stores.db.query<EventRowView>(
    `SELECT event_type, source_system, external_event_id, safe_metadata
       FROM public.payment_events
      WHERE payment_intent_id = $1
      ORDER BY recorded_at`,
    [paymentIntentId],
  );
  return result.rows;
}

maybeDescribe('OutboxWorker integration (disposable Postgres only)', () => {
  it('processes a confirmed payment end to end', async () => {
    const seeded = await confirmedIntent('worker-e2e-success');
    const before = await outboxRow(seeded.paymentIntentId);
    expect(before?.state).toBe('pending');
    expect(before?.command_type).toBe('submit_payment');

    const sponsor = new SimulatorSponsorDfspConnector(systemClock, {});
    const worker = new OutboxWorker(
      {
        outbox: stores.outbox,
        events: stores.events,
        sponsor,
        clock: systemClock,
        workerId: 'int-worker-1',
      },
      { retryBackoffMs: [1_000] },
    );
    const batch = await worker.runBatch();
    expect(batch.published).toBe(1);

    const after = await outboxRow(seeded.paymentIntentId);
    expect(after?.state).toBe('published');

    const submission = (await eventsFor(seeded.paymentIntentId)).find(
      (event) => event.source_system === 'worker-submission',
    );
    expect(submission?.external_event_id).toMatch(/^STX-\d{6}$/);
    expect(submission?.safe_metadata['outcome']).toBe('committed');

    // The worker does not project product payment state; scenario projections are
    // TICKET-006 scope. State transitions stay behind reviewed command paths.
    const intent = await stores.intents.findById(seeded.paymentIntentId);
    expect(intent?.state).toBe('user_authorized');

    const again = await worker.runBatch();
    expect(again.claimed).toBe(0);
  });

  it('reconciles a timeout_unknown submission through the ORIGINAL external id', async () => {
    const seeded = await confirmedIntent('worker-e2e-timeout');
    const sponsor = new SimulatorSponsorDfspConnector(systemClock, {
      script: ['timeout_unknown'],
    });
    const worker = new OutboxWorker(
      {
        outbox: stores.outbox,
        events: stores.events,
        sponsor,
        clock: systemClock,
        workerId: 'int-worker-2',
      },
      { retryBackoffMs: [1_000] },
    );

    const first = await worker.runBatch();
    expect(first.pendingRetry).toBe(1);
    const rowAfterFirst = await outboxRow(seeded.paymentIntentId);
    expect(rowAfterFirst?.state).toBe('pending');
    expect(rowAfterFirst?.last_error_code).toBe('timeout_unknown');

    const submission = (await eventsFor(seeded.paymentIntentId)).find(
      (event) => event.source_system === 'worker-submission',
    );
    const externalId = submission?.external_event_id;
    expect(externalId).toMatch(/^STX-\d{6}$/);

    await sleep(1_100); // retry backoff elapses
    const second = await worker.runBatch();
    expect(second.published).toBe(1);

    const events = await eventsFor(seeded.paymentIntentId);
    const submissions = events.filter((event) => event.source_system === 'worker-submission');
    expect(submissions).toHaveLength(1); // never resubmitted
    const reconciliation = events.find((event) => event.source_system === 'worker-reconciliation');
    expect(reconciliation?.external_event_id).toBe(externalId); // the ORIGINAL id
    expect(reconciliation?.safe_metadata['query_status']).toBe('committed');
    expect(reconciliation?.safe_metadata['evidence_source']).toBe('SIMULATOR');
    expect((await outboxRow(seeded.paymentIntentId))?.state).toBe('published');
  });

  it('reclaims an expired lease from a crashed worker and completes safely', async () => {
    const seeded = await confirmedIntent('worker-e2e-crash');

    // A first "worker" claims the command and crashes without finishing (simulated by
    // claiming directly through the repository and never calling finish).
    const claimed = await stores.outbox.claim({
      workerId: 'crashed-worker',
      limit: 1,
      leaseSeconds: 5,
    });
    expect(claimed).toHaveLength(1);

    // While the lease is held, a healthy worker claims nothing.
    const sponsor = new SimulatorSponsorDfspConnector(systemClock, {});
    const worker = new OutboxWorker(
      {
        outbox: stores.outbox,
        events: stores.events,
        sponsor,
        clock: systemClock,
        workerId: 'int-worker-3',
      },
      { retryBackoffMs: [1_000] },
    );
    const duringLease = await worker.runBatch();
    expect(duringLease.claimed).toBe(0);

    await sleep(5_300); // the crashed worker's lease expires
    const batch = await worker.runBatch();
    expect(batch.published).toBe(1);
    const row = await outboxRow(seeded.paymentIntentId);
    expect(row?.state).toBe('published');
    expect(row?.attempts).toBe(2); // crashed claim + safe reclaim
    expect(row?.last_error_code).toBeNull();

    const submission = (await eventsFor(seeded.paymentIntentId)).find(
      (event) => event.source_system === 'worker-submission',
    );
    expect(submission?.safe_metadata['outcome']).toBe('committed');
  });

  afterAll(async () => {
    await pool.end();
  });
});
