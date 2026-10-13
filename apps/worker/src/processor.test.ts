import { describe, expect, it } from 'vitest';
import type {
  Clock,
  OutboxMessageRecord,
  OutboxRepository,
  PaymentEventAppend,
  PaymentEventRepository,
  QuoteOutcome,
  QuoteRequest,
  ReconciliationEvidence,
  OutboxSubmissionEvidence,
  SubmissionEvidenceRepository,
  SponsorDfspPort,
  TransferCommand,
  TransferQueryOutcome,
  TransferSubmissionOutcome,
} from '@eeeasy-pay/ports';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import { sha256Hex } from '@eeeasy-pay/pal';
import { OutboxWorker, SUBMIT_PAYMENT_COMMAND, type OutboxWorkerOptions } from './processor.ts';

class MutableClock implements Clock {
  private at: Date;
  constructor(at: Date) {
    this.at = at;
  }
  now(): Date {
    return new Date(this.at.getTime());
  }
  nowIso(): string {
    return this.at.toISOString();
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

const FIXED = new Date('2026-10-13T00:00:00.000Z');

const PAYLOAD: Record<string, unknown> = {
  payment_intent_id: '4a4a4a4a-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  quote_id: '5b5b5b5b-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  correlation_id: '6c6c6c6c-cccc-4ccc-8ccc-cccccccccccc',
  quote_binding_sha256: 'ab'.repeat(32),
};

interface FakeRow {
  outboxMessageId: string;
  commandType: string;
  safePayload: Record<string, unknown>;
  state: 'pending' | 'leased' | 'published' | 'dead_letter';
  attempts: number;
  availableAtMs: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntilMs: number | null;
  lastErrorCode: string | null;
}

class FakeOutbox implements OutboxRepository {
  readonly rows = new Map<string, FakeRow>();
  /** When set, the next finish() calls throw this many times (crash-before-finish). */
  failNextFinishes = 0;
  private seq = 0;

  constructor(private readonly clock: MutableClock) {}

  async enqueue(input: {
    aggregateType: string;
    aggregateId: string;
    commandType: string;
    schemaVersion: number;
    idempotencyKeyDigest: string;
    payloadDigest: string;
    safePayload: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    this.seq += 1;
    const id = 'msg-' + String(this.seq);
    this.rows.set(id, {
      outboxMessageId: id,
      commandType: input.commandType,
      safePayload: { ...input.safePayload },
      state: 'pending',
      attempts: 0,
      availableAtMs: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseUntilMs: null,
      lastErrorCode: null,
    });
    return id;
  }

  async claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<OutboxMessageRecord[]> {
    const now = this.clock.now().getTime();
    const claimed: OutboxMessageRecord[] = [];
    for (const row of this.rows.values()) {
      if (claimed.length >= input.limit) {
        break;
      }
      const claimable =
        (row.state === 'pending' && row.availableAtMs <= now) ||
        (row.state === 'leased' && row.leaseUntilMs !== null && row.leaseUntilMs < now);
      if (!claimable) {
        continue;
      }
      row.state = 'leased';
      row.leaseOwner = input.workerId;
      row.leaseToken = 'lease-' + row.outboxMessageId + '-' + String(row.attempts);
      row.leaseUntilMs = now + input.leaseSeconds * 1000;
      row.attempts += 1;
      claimed.push(this.toRecord(row));
    }
    return claimed;
  }

  async finish(input: {
    outboxMessageId: string;
    workerId: string;
    leaseToken: string;
    published: boolean;
    retryAt?: string;
    errorCode?: string;
  }): Promise<boolean> {
    if (this.failNextFinishes > 0) {
      this.failNextFinishes -= 1;
      throw new Error('simulated crash before finish');
    }
    const row = this.rows.get(input.outboxMessageId);
    if (
      !row ||
      row.state !== 'leased' ||
      row.leaseOwner !== input.workerId ||
      row.leaseToken !== input.leaseToken
    ) {
      return false;
    }
    if (input.published) {
      row.state = 'published';
      row.lastErrorCode = null;
    } else if (input.retryAt !== undefined) {
      row.state = 'pending';
      row.availableAtMs = Date.parse(input.retryAt);
      row.lastErrorCode = input.errorCode ?? 'unspecified';
    } else {
      row.state = 'dead_letter';
      row.lastErrorCode = input.errorCode ?? 'unspecified';
    }
    row.leaseOwner = null;
    row.leaseToken = null;
    row.leaseUntilMs = null;
    return true;
  }

  toRecord(row: FakeRow): OutboxMessageRecord {
    return {
      outboxMessageId: row.outboxMessageId,
      aggregateType: 'payment_intent',
      aggregateId: PAYLOAD['payment_intent_id'] as string,
      commandType: row.commandType,
      schemaVersion: 1,
      idempotencyKeyDigest: 'cd'.repeat(32),
      payloadDigest: 'ef'.repeat(32),
      safePayload: row.safePayload,
      state: row.state,
      attempts: row.attempts,
      availableAt: new Date(row.availableAtMs).toISOString(),
      ...(row.leaseOwner !== null ? { leaseOwner: row.leaseOwner } : {}),
      ...(row.leaseToken !== null ? { leaseToken: row.leaseToken } : {}),
    };
  }
}

class FakeEventStore implements PaymentEventRepository, SubmissionEvidenceRepository {
  readonly appended: PaymentEventAppend[] = [];
  failAppend = false;

  async appendEvent(event: PaymentEventAppend): Promise<string> {
    if (this.failAppend) {
      throw new Error('evidence store unavailable');
    }
    this.appended.push(event);
    return 'event-' + String(this.appended.length);
  }

  async findSubmissionByOutboxMessage(
    paymentIntentId: string,
    outboxMessageId: string,
  ): Promise<OutboxSubmissionEvidence | null> {
    const found = [...this.appended]
      .reverse()
      .find(
        (event) =>
          event.eventType === WORKER_SUBMISSION_EVENT.eventType &&
          event.paymentIntentId === paymentIntentId &&
          event.safeMetadata['outbox_message_id'] === outboxMessageId,
      );
    const external = found?.externalEventId;
    const outcome = found?.safeMetadata['outcome'];
    if (
      !found ||
      external === undefined ||
      (outcome !== 'committed' && outcome !== 'rejected' && outcome !== 'timeout_unknown')
    ) {
      return null;
    }
    return { outboxMessageId, externalTransferId: external, outcome };
  }

  async findReconciliationByExternalId(
    externalTransferId: string,
  ): Promise<ReconciliationEvidence | null> {
    const found = [...this.appended]
      .reverse()
      .find(
        (event) =>
          event.eventType === WORKER_RECONCILIATION_EVENT.eventType &&
          event.externalEventId === externalTransferId,
      );
    const status = found?.safeMetadata['query_status'];
    if (!found || (status !== 'committed' && status !== 'rejected')) {
      return null;
    }
    return { externalTransferId, resolvedStatus: status };
  }
}

type Scenario = 'committed' | 'rejected' | 'timeout_unknown';

class FakeSponsor implements SponsorDfspPort {
  readonly submits: TransferCommand[] = [];
  readonly queries: string[] = [];
  /** Optional hook invoked inside submitTransfer, before the outcome is returned. */
  onSubmit: (() => Promise<unknown>) | undefined;
  private cursor = 0;

  constructor(
    private readonly script: readonly Scenario[] = ['committed'],
    private readonly queryResults: readonly ('committed' | 'rejected' | 'unknown')[] = [
      'committed',
    ],
  ) {}

  async quote(request: QuoteRequest): Promise<QuoteOutcome> {
    void request;
    throw new Error('the outbox worker never quotes');
  }

  async submitTransfer(command: TransferCommand): Promise<TransferSubmissionOutcome> {
    const scenario = this.script[this.cursor % this.script.length] ?? 'committed';
    this.cursor += 1;
    const externalTransferId = 'STX-' + String(this.submits.length + 1).padStart(6, '0');
    this.submits.push(command);
    if (this.onSubmit) {
      await this.onSubmit();
    }
    if (scenario === 'rejected') {
      return {
        kind: 'rejected',
        externalTransferId,
        reasonCode: 'simulator_rejected',
        occurredAt: FIXED.toISOString(),
      };
    }
    if (scenario === 'timeout_unknown') {
      return { kind: 'timeout_unknown', externalTransferId, occurredAt: FIXED.toISOString() };
    }
    return {
      kind: 'committed',
      externalTransferId,
      evidenceSource: 'SIMULATOR',
      evidenceRef: 'sim-evidence-' + externalTransferId,
      occurredAt: FIXED.toISOString(),
    };
  }

  async queryTransfer(externalTransferId: string): Promise<TransferQueryOutcome> {
    this.queries.push(externalTransferId);
    const index = Math.min(this.queries.length - 1, this.queryResults.length - 1);
    const status = this.queryResults[index] ?? 'committed';
    return {
      externalTransferId,
      status,
      occurredAt: FIXED.toISOString(),
      ...(status === 'committed'
        ? {
            evidenceSource: 'SIMULATOR' as const,
            evidenceRef: 'sim-evidence-' + externalTransferId,
          }
        : {}),
    };
  }
}

interface HarnessSetup {
  script?: readonly Scenario[];
  queryResults?: readonly ('committed' | 'rejected' | 'unknown')[];
  workerOptions?: OutboxWorkerOptions;
}

function harness(setup: HarnessSetup = {}) {
  const clock = new MutableClock(FIXED);
  const outbox = new FakeOutbox(clock);
  const events = new FakeEventStore();
  const sponsor = new FakeSponsor(setup.script ?? ['committed'], setup.queryResults);
  const worker = new OutboxWorker(
    { outbox, events, sponsor, clock, workerId: 'worker-a' },
    setup.workerOptions,
  );
  return { clock, outbox, events, sponsor, worker };
}

async function enqueueCommand(
  outbox: FakeOutbox,
  overrides: { commandType?: string; safePayload?: Record<string, unknown> } = {},
): Promise<string> {
  return outbox.enqueue({
    aggregateType: 'payment_intent',
    aggregateId: PAYLOAD['payment_intent_id'] as string,
    commandType: overrides.commandType ?? SUBMIT_PAYMENT_COMMAND,
    schemaVersion: 1,
    idempotencyKeyDigest: sha256Hex('fake-idem-' + String(outbox.rows.size + 1)),
    payloadDigest: sha256Hex('fake-payload-' + String(outbox.rows.size + 1)),
    safePayload: overrides.safePayload ?? PAYLOAD,
  });
}

describe('OutboxWorker', () => {
  it('publishes a committed submission and records its evidence', async () => {
    const h = harness();
    const id = await enqueueCommand(h.outbox);
    const result = await h.worker.runBatch();
    expect(result).toEqual({
      claimed: 1,
      published: 1,
      pendingRetry: 0,
      deadLettered: 0,
      leaseLost: 0,
    });
    expect(h.outbox.rows.get(id)?.state).toBe('published');
    expect(h.sponsor.submits).toHaveLength(1);
    expect(h.events.appended).toHaveLength(1);
    const event = h.events.appended[0];
    expect(event?.eventType).toBe('TransferSubmissionRecorded');
    expect(event?.sourceSystem).toBe('worker-submission');
    expect(event?.externalEventId).toBe('STX-000001');
    expect(event?.safeMetadata['outcome']).toBe('committed');
    expect(event?.privacyClass).toBe('operational_minimal');
  });

  it('treats a rejected submission as processed and publishes the command', async () => {
    const h = harness({ script: ['rejected'] });
    const id = await enqueueCommand(h.outbox);
    const result = await h.worker.runBatch();
    expect(result.published).toBe(1);
    expect(result.pendingRetry).toBe(0);
    expect(h.outbox.rows.get(id)?.state).toBe('published');
    const event = h.events.appended[0];
    expect(event?.safeMetadata['outcome']).toBe('rejected');
  });

  it('schedules a retry for timeout_unknown and records the ORIGINAL external id', async () => {
    const h = harness({ script: ['timeout_unknown'] });
    const id = await enqueueCommand(h.outbox);
    const result = await h.worker.runBatch();
    expect(result.pendingRetry).toBe(1);
    expect(result.published).toBe(0);
    const row = h.outbox.rows.get(id);
    expect(row?.state).toBe('pending');
    expect(row?.lastErrorCode).toBe('timeout_unknown');
    const event = h.events.appended[0];
    expect(event?.externalEventId).toBe('STX-000001');
    expect(event?.safeMetadata['outcome']).toBe('timeout_unknown');
  });

  it('reconciles the ORIGINAL external id on retry without resubmitting', async () => {
    const h = harness({ script: ['timeout_unknown'], workerOptions: { retryBackoffMs: [0] } });
    const id = await enqueueCommand(h.outbox);
    await h.worker.runBatch();
    const second = await h.worker.runBatch();
    expect(second.published).toBe(1);
    expect(h.sponsor.submits).toHaveLength(1); // NEVER resubmitted
    expect(h.sponsor.queries).toEqual(['STX-000001']); // the ORIGINAL id
    expect(h.outbox.rows.get(id)?.state).toBe('published');
    const submissions = h.events.appended.filter(
      (event) => event.eventType === WORKER_SUBMISSION_EVENT.eventType,
    );
    expect(submissions).toHaveLength(1);
    const reconciliation = h.events.appended.find(
      (event) => event.eventType === WORKER_RECONCILIATION_EVENT.eventType,
    );
    expect(reconciliation?.externalEventId).toBe('STX-000001');
    expect(reconciliation?.safeMetadata['query_status']).toBe('committed');
    expect(reconciliation?.safeMetadata['evidence_source']).toBe('SIMULATOR');
  });

  it('keeps retrying while reconciliation stays unknown', async () => {
    const h = harness({
      script: ['timeout_unknown'],
      queryResults: ['unknown', 'committed'],
      workerOptions: { retryBackoffMs: [0] },
    });
    const id = await enqueueCommand(h.outbox);
    const first = await h.worker.runBatch();
    expect(first.pendingRetry).toBe(1);
    const second = await h.worker.runBatch();
    expect(second.pendingRetry).toBe(1); // query said unknown, still ambiguous
    const third = await h.worker.runBatch();
    expect(third.published).toBe(1);
    expect(h.sponsor.submits).toHaveLength(1);
    expect(h.sponsor.queries).toEqual(['STX-000001', 'STX-000001']);
    expect(h.outbox.rows.get(id)?.state).toBe('published');
  });

  it('recovers a crashed claim through lease expiry and reconciles without resubmitting', async () => {
    const h = harness({
      script: ['timeout_unknown'],
      workerOptions: { leaseSeconds: 5, retryBackoffMs: [0] },
    });
    const id = await enqueueCommand(h.outbox);
    h.outbox.failNextFinishes = 2; // crash before finish, including the catch path
    const crashed = await h.worker.runBatch();
    expect(crashed.leaseLost).toBe(1);
    expect(h.outbox.rows.get(id)?.state).toBe('leased'); // lease still held
    h.clock.advance(6_000); // lease expires; the message returns to claimable
    const recovered = await h.worker.runBatch();
    expect(recovered.published).toBe(1);
    expect(h.sponsor.submits).toHaveLength(1); // reconciled, never resubmitted
    expect(h.sponsor.queries).toEqual(['STX-000001']);
    expect(h.outbox.rows.get(id)?.state).toBe('published');
  });

  it('dead-letters after the retry horizon is exhausted', async () => {
    const h = harness({
      script: ['timeout_unknown'],
      queryResults: ['unknown'],
      workerOptions: { retryBackoffMs: [0], maxAttempts: 2 },
    });
    const id = await enqueueCommand(h.outbox);
    const first = await h.worker.runBatch();
    expect(first.pendingRetry).toBe(1);
    const second = await h.worker.runBatch();
    expect(second.deadLettered).toBe(1);
    const row = h.outbox.rows.get(id);
    expect(row?.state).toBe('dead_letter');
    expect(row?.lastErrorCode).toBe('reconciliation_pending');
  });

  it('dead-letters unsupported command types without touching the sponsor', async () => {
    const h = harness();
    const id = await enqueueCommand(h.outbox, { commandType: 'noop_command' });
    const result = await h.worker.runBatch();
    expect(result.deadLettered).toBe(1);
    expect(h.sponsor.submits).toHaveLength(0);
    const row = h.outbox.rows.get(id);
    expect(row?.state).toBe('dead_letter');
    expect(row?.lastErrorCode).toBe('unsupported_command_type');
  });

  it('dead-letters commands with an invalid safe_payload', async () => {
    const h = harness();
    const id = await enqueueCommand(h.outbox, {
      safePayload: { payment_intent_id: 'not-a-uuid' },
    });
    const result = await h.worker.runBatch();
    expect(result.deadLettered).toBe(1);
    expect(h.sponsor.submits).toHaveLength(0);
    const row = h.outbox.rows.get(id);
    expect(row?.lastErrorCode).toBe('invalid_safe_payload');
  });

  it('dead-letters when submission evidence cannot be recorded after an external submission', async () => {
    const h = harness();
    h.events.failAppend = true;
    const id = await enqueueCommand(h.outbox);
    const result = await h.worker.runBatch();
    expect(result.deadLettered).toBe(1); // NOT retried: a retry would resubmit
    expect(h.sponsor.submits).toHaveLength(1);
    const row = h.outbox.rows.get(id);
    expect(row?.state).toBe('dead_letter');
    expect(row?.lastErrorCode).toBe('evidence_write_failed');
  });

  it('counts a lost lease when another claim takes over mid-flight', async () => {
    const h = harness({ workerOptions: { leaseSeconds: 5 } });
    const id = await enqueueCommand(h.outbox);
    h.sponsor.onSubmit = async () => {
      h.clock.advance(6_000); // the worker's lease expires mid-submission
      await h.outbox.claim({ workerId: 'worker-b', limit: 1, leaseSeconds: 60 });
    };
    const result = await h.worker.runBatch();
    expect(result.leaseLost).toBe(1);
    const row = h.outbox.rows.get(id);
    expect(row?.state).toBe('leased'); // worker-b now owns the lease
    expect(row?.leaseOwner).toBe('worker-b');
  });

  it('drains until nothing is claimable', async () => {
    const h = harness({ workerOptions: { claimLimit: 2 } });
    await enqueueCommand(h.outbox);
    await enqueueCommand(h.outbox);
    await enqueueCommand(h.outbox);
    const total = await h.worker.drain();
    expect(total.claimed).toBe(3);
    expect(total.published).toBe(3);
    expect(h.sponsor.submits).toHaveLength(3);
  });
});
