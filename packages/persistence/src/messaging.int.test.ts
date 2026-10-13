import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Db } from './db.ts';
import { InboxPayloadConflictError } from '@eeeasy-pay/ports';
import { sha256Hex } from '@eeeasy-pay/pal';
import { deterministicId, seedQuotedIntent, seedUser } from './int-helpers.ts';
import { createPersistenceStores } from './stores.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require a disposable Postgres database ' +
      'with ci/db/prepare.sql and all supabase/migrations applied (see README.md).',
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const stores = createPersistenceStores(pool);
const db: Db = stores.db;

const USER_M = deterministicId('user', 'messaging');

async function count(where: string, params: unknown[]): Promise<number> {
  const result = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${where}`, params);
  return Number(result.rows[0]?.n ?? '0');
}

async function enqueueOne(ref: string): Promise<string> {
  return stores.outbox.enqueue({
    aggregateType: 'payment_intent',
    aggregateId: deterministicId('aggregate', ref),
    commandType: 'sim_command',
    schemaVersion: 1,
    idempotencyKeyDigest: sha256Hex('outbox-key:' + ref),
    payloadDigest: sha256Hex('outbox-payload:' + ref),
    safePayload: { ref },
  });
}

afterAll(async () => {
  await pool.end();
});

describe('payment event repository', () => {
  it('appends events and enforces external event id uniqueness', async () => {
    await seedUser(db, USER_M);
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_M, ref: 'events-intent' });

    const eventId = await stores.events.appendEvent({
      paymentIntentId: seeded.paymentIntentId,
      eventType: 'IntentCreated',
      schemaVersion: 1,
      sourceSystem: 'pal',
      externalEventId: 'sim-external-1',
      correlationId: deterministicId('correlation', 'events'),
      previousState: 'created',
      nextState: 'quoting',
      payloadDigest: sha256Hex('event-payload-1'),
      privacyClass: 'operational_minimal',
      safeMetadata: { note: 'simulator' },
    });
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);

    // (source_system, external_event_id) is unique: a second append under the same pair
    // must fail rather than duplicate history.
    await expect(
      stores.events.appendEvent({
        paymentIntentId: seeded.paymentIntentId,
        eventType: 'IntentCreated',
        schemaVersion: 1,
        sourceSystem: 'pal',
        externalEventId: 'sim-external-1',
        correlationId: deterministicId('correlation', 'events'),
        payloadDigest: sha256Hex('event-payload-2'),
        privacyClass: 'operational_minimal',
        safeMetadata: {},
      }),
    ).rejects.toThrow();
  });
});

describe('outbox claim/finish', () => {
  it('hands each message to exactly one worker and publishes exactly once', async () => {
    await enqueueOne('claim-a');
    await enqueueOne('claim-b');
    await enqueueOne('claim-c');

    const first = await stores.outbox.claim({ workerId: 'worker-1', limit: 2, leaseSeconds: 60 });
    expect(first).toHaveLength(2);
    for (const message of first) {
      expect(message.state).toBe('leased');
      expect(message.attempts).toBe(1);
      expect(message.leaseOwner).toBe('worker-1');
      expect(message.leaseToken).toBeDefined();
    }

    // A second worker claims the remainder only: disjoint by SKIP LOCKED.
    const second = await stores.outbox.claim({ workerId: 'worker-2', limit: 5, leaseSeconds: 60 });
    expect(second).toHaveLength(1);
    expect(second[0]?.leaseOwner).toBe('worker-2');
    const claimedIds = new Set([...first, ...second].map((m) => m.outboxMessageId));
    expect(claimedIds.size).toBe(3);

    // Nothing is claimable while all messages are leased.
    await expect(
      stores.outbox.claim({ workerId: 'worker-3', limit: 5, leaseSeconds: 60 }),
    ).resolves.toHaveLength(0);

    // A wrong lease token cannot finish; the right one publishes exactly once.
    const target = first[0];
    expect(target).toBeDefined();
    if (!target) {
      throw new Error('expected a claimed message');
    }
    const wrongToken = deterministicId('lease-token', 'wrong');
    await expect(
      stores.outbox.finish({
        outboxMessageId: target.outboxMessageId,
        workerId: 'worker-1',
        leaseToken: wrongToken,
        published: true,
      }),
    ).resolves.toBe(false);
    await expect(
      stores.outbox.finish({
        outboxMessageId: target.outboxMessageId,
        workerId: 'worker-1',
        leaseToken: target.leaseToken ?? wrongToken,
        published: true,
      }),
    ).resolves.toBe(true);
    await expect(
      stores.outbox.finish({
        outboxMessageId: target.outboxMessageId,
        workerId: 'worker-1',
        leaseToken: target.leaseToken ?? wrongToken,
        published: true,
      }),
    ).resolves.toBe(false);
    expect(
      await count('FROM public.outbox_messages WHERE outbox_message_id = $1 AND state = $2', [
        target.outboxMessageId,
        'published',
      ]),
    ).toBe(1);
  });

  it('sends a failed publish back to pending with a retry horizon', async () => {
    await enqueueOne('retry');
    const [message] = await stores.outbox.claim({
      workerId: 'worker-retry',
      limit: 1,
      leaseSeconds: 60,
    });
    expect(message).toBeDefined();
    if (!message) {
      throw new Error('expected a claimed message');
    }
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      stores.outbox.finish({
        outboxMessageId: message.outboxMessageId,
        workerId: 'worker-retry',
        leaseToken: message.leaseToken ?? '',
        published: false,
        retryAt,
        errorCode: 'sim_transient',
      }),
    ).resolves.toBe(true);
    const row = await db.query<{
      state: string;
      available_at: Date;
      last_error_code: string | null;
    }>(
      'SELECT state, available_at, last_error_code FROM public.outbox_messages WHERE outbox_message_id = $1',
      [message.outboxMessageId],
    );
    expect(row.rows[0]?.state).toBe('pending');
    expect(new Date(row.rows[0]?.available_at ?? 0).toISOString()).toBe(retryAt);
    expect(row.rows[0]?.last_error_code).toBe('sim_transient');
    // Not claimable until the retry horizon.
    await expect(
      stores.outbox.claim({ workerId: 'worker-retry-2', limit: 5, leaseSeconds: 60 }),
    ).resolves.toHaveLength(0);
  });

  it('dead-letters an unretryable failure', async () => {
    await enqueueOne('dead');
    const [message] = await stores.outbox.claim({
      workerId: 'worker-dead',
      limit: 1,
      leaseSeconds: 60,
    });
    expect(message).toBeDefined();
    if (!message) {
      throw new Error('expected a claimed message');
    }
    await expect(
      stores.outbox.finish({
        outboxMessageId: message.outboxMessageId,
        workerId: 'worker-dead',
        leaseToken: message.leaseToken ?? '',
        published: false,
        errorCode: 'sim_permanent',
      }),
    ).resolves.toBe(true);
    const row = await db.query<{ state: string }>(
      'SELECT state FROM public.outbox_messages WHERE outbox_message_id = $1',
      [message.outboxMessageId],
    );
    expect(row.rows[0]?.state).toBe('dead_letter');
    await expect(
      stores.outbox.claim({ workerId: 'worker-dead-2', limit: 5, leaseSeconds: 60 }),
    ).resolves.toHaveLength(0);
  });

  it('reclaims a message whose lease expired', async () => {
    await enqueueOne('expired-lease');
    const first = await stores.outbox.claim({
      workerId: 'worker-expired',
      limit: 1,
      leaseSeconds: 5,
    });
    expect(first).toHaveLength(1);
    const original = first[0];
    expect(original).toBeDefined();
    if (!original) {
      throw new Error('expected a claimed message');
    }
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    const reclaimed = await stores.outbox.claim({
      workerId: 'worker-expired-2',
      limit: 5,
      leaseSeconds: 60,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.outboxMessageId).toBe(original.outboxMessageId);
    expect(reclaimed[0]?.attempts).toBe(2);
    expect(reclaimed[0]?.leaseToken).not.toBe(original.leaseToken);
  });
});

describe('inbox ingest', () => {
  it('dedupes replays and conflicts on payload-hash mismatch', async () => {
    await seedUser(db, USER_M);
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_M, ref: 'inbox-intent' });
    const providerEventId = 'sim-provider-event-1';
    const first = await stores.inbox.ingest({
      providerKey: 'sim-dfsp',
      providerEventId,
      payloadDigest: sha256Hex('inbox-payload-1'),
      schemaVersion: 1,
      paymentIntentId: seeded.paymentIntentId,
      correlationId: deterministicId('correlation', 'inbox'),
      authenticatedPrincipal: 'sim-principal-1',
      normalizedPayload: { state: 'transfer_processing' },
    });
    expect(first.replayed).toBe(false);

    const replay = await stores.inbox.ingest({
      providerKey: 'sim-dfsp',
      providerEventId,
      payloadDigest: sha256Hex('inbox-payload-1'),
      schemaVersion: 1,
      paymentIntentId: seeded.paymentIntentId,
      correlationId: deterministicId('correlation', 'inbox'),
      authenticatedPrincipal: 'sim-principal-1',
      normalizedPayload: { state: 'transfer_processing' },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.inboxEventId).toBe(first.inboxEventId);

    await expect(
      stores.inbox.ingest({
        providerKey: 'sim-dfsp',
        providerEventId,
        payloadDigest: sha256Hex('inbox-payload-CHANGED'),
        schemaVersion: 1,
        correlationId: deterministicId('correlation', 'inbox'),
        authenticatedPrincipal: 'sim-principal-1',
        normalizedPayload: { state: 'transfer_committed' },
      }),
    ).rejects.toBeInstanceOf(InboxPayloadConflictError);

    expect(
      await count('FROM public.inbox_events WHERE provider_event_id = $1', [providerEventId]),
    ).toBe(1);
  });

  it('keeps concurrent identical ingests to a single row', async () => {
    const providerEventId = 'sim-provider-event-race';
    const digest = sha256Hex('inbox-payload-race');
    const build = () => ({
      providerKey: 'sim-dfsp',
      providerEventId,
      payloadDigest: digest,
      schemaVersion: 1,
      correlationId: deterministicId('correlation', 'inbox-race'),
      authenticatedPrincipal: 'sim-principal-1',
      normalizedPayload: { state: 'transfer_committed' },
    });
    const results = await Promise.all([stores.inbox.ingest(build()), stores.inbox.ingest(build())]);
    expect(results[0]?.inboxEventId).toBe(results[1]?.inboxEventId);
    expect(
      await count('FROM public.inbox_events WHERE provider_event_id = $1', [providerEventId]),
    ).toBe(1);
  });
});
