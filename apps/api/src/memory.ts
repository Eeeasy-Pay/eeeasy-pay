// In-memory repository implementations for the simulator-only product API (TICKET-003).
// They exist so the HTTP layer has narrow, ports-shaped seams; TICKET-004 replaces them
// with Postgres repositories over the reviewed migrations. Synchronous Map storage makes
// each transaction trivially atomic here; the Postgres versions must use real
// transactional boundaries (ADR-006), including durable outbox claiming with leases.

import type { QuoteV1, SettlementStateV1 } from '@eeeasy-pay/contracts';
import type { QuoteBindingTerms } from '@eeeasy-pay/pal';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import type {
  Clock,
  IdempotencyReplay,
  IdempotencyRepository,
  OutboxMessageRecord,
  OutboxRepository,
  OutboxSubmissionEvidence,
  PaymentEventAppend,
  PaymentEventRepository,
  PaymentIntentRecord,
  PaymentIntentRepository,
  ReconciliationEvidence,
  SubmissionEvidenceRepository,
  TransactionBoundary,
  UuidGenerator,
} from '@eeeasy-pay/ports';

export interface IntentRecord extends PaymentIntentRecord {
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Separately-tracked settlement dimension (TICKET-006). Absent means 'not_applicable'
   * (the migrations' default). Only the explicitly simulated settlement stage ever sets
   * it; a submission ack NEVER implies settlement (GUARDRAILS.md #3).
   */
  readonly settlementState?: SettlementStateV1;
}

export class MemoryIntentStore implements PaymentIntentRepository {
  private readonly records = new Map<string, IntentRecord>();

  put(record: IntentRecord): void {
    this.records.set(record.paymentIntentId, record);
  }

  peek(paymentIntentId: string): IntentRecord | null {
    return this.records.get(paymentIntentId) ?? null;
  }

  async findById(paymentIntentId: string): Promise<IntentRecord | null> {
    return this.peek(paymentIntentId);
  }

  async findOwnedById(paymentIntentId: string, actorId: string): Promise<IntentRecord | null> {
    const record = this.peek(paymentIntentId);
    return record !== null && record.actorId === actorId ? record : null;
  }
}

export interface StoredQuote {
  readonly quoteId: string;
  readonly quote: QuoteV1;
  readonly binding: QuoteBindingTerms;
}

export class MemoryQuoteStore {
  private readonly quotes = new Map<string, StoredQuote>();

  put(stored: StoredQuote): void {
    this.quotes.set(stored.quoteId, stored);
  }

  findByQuoteId(quoteId: string): StoredQuote | null {
    return this.quotes.get(quoteId) ?? null;
  }
}

type IdempotencyLifecycle = 'reserved' | 'accepted' | 'completed' | 'failed';

interface MemoryIdempotencyEntry {
  readonly actorId: string;
  readonly operation: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly resourceRef: string | undefined;
  lifecycle: IdempotencyLifecycle;
}

export class MemoryIdempotencyRepository implements IdempotencyRepository {
  private readonly entries = new Map<string, MemoryIdempotencyEntry>();

  private keyOf(actorId: string, operation: string, keyDigest: string): string {
    return actorId + '\u0000' + operation + '\u0000' + keyDigest;
  }

  async reserve(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
    resourceRef?: string;
  }): Promise<IdempotencyReplay> {
    const key = this.keyOf(input.actorId, input.operation, input.keyDigest);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      return {
        replayed: true,
        requestMatched: existing.requestDigest === input.requestDigest,
        ...(existing.resourceRef !== undefined ? { resourceRef: existing.resourceRef } : {}),
      };
    }
    this.entries.set(key, {
      actorId: input.actorId,
      operation: input.operation,
      keyDigest: input.keyDigest,
      requestDigest: input.requestDigest,
      resourceRef: input.resourceRef,
      lifecycle: 'reserved',
    });
    return {
      replayed: false,
      requestMatched: true,
      ...(input.resourceRef !== undefined ? { resourceRef: input.resourceRef } : {}),
    };
  }

  private mark(
    input: { actorId: string; operation: string; keyDigest: string },
    lifecycle: IdempotencyLifecycle,
  ): void {
    const entry = this.entries.get(this.keyOf(input.actorId, input.operation, input.keyDigest));
    if (entry !== undefined) {
      entry.lifecycle = lifecycle;
    }
  }

  async markAccepted(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
  }): Promise<void> {
    this.mark(input, 'accepted');
  }

  async markCompleted(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
  }): Promise<void> {
    this.mark(input, 'completed');
  }

  async markFailed(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
  }): Promise<void> {
    this.mark(input, 'failed');
  }
}

export class MemoryOutboxRepository implements OutboxRepository {
  private readonly messages = new Map<string, OutboxMessageRecord>();

  constructor(
    private readonly uuid: UuidGenerator,
    private readonly clock: Clock,
  ) {}

  /** Scenario reads (TICKET-006): durable commands ever enqueued on this seam. */
  messageCount(): number {
    return this.messages.size;
  }

  async enqueue(input: {
    aggregateType: string;
    aggregateId: string;
    commandType: string;
    schemaVersion: number;
    idempotencyKeyDigest: string;
    payloadDigest: string;
    safePayload: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const outboxMessageId = this.uuid.next();
    this.messages.set(outboxMessageId, {
      outboxMessageId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      commandType: input.commandType,
      schemaVersion: input.schemaVersion,
      idempotencyKeyDigest: input.idempotencyKeyDigest,
      payloadDigest: input.payloadDigest,
      safePayload: input.safePayload,
      state: 'pending',
      attempts: 0,
      availableAt: this.clock.nowIso(),
    });
    return outboxMessageId;
  }

  // Simulator limitation: an expired lease is not reclaimable here; durable lease-based
  // claiming (with reclaim after lease expiry) lands in TICKET-004/TICKET-005.
  async claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<OutboxMessageRecord[]> {
    const nowMs = this.clock.now().getTime();
    const claimed: OutboxMessageRecord[] = [];
    for (const message of this.messages.values()) {
      if (claimed.length >= input.limit) {
        break;
      }
      if (message.state !== 'pending' || Date.parse(message.availableAt) > nowMs) {
        continue;
      }
      const leased: OutboxMessageRecord = {
        ...message,
        state: 'leased',
        attempts: message.attempts + 1,
        availableAt: new Date(nowMs + input.leaseSeconds * 1000).toISOString(),
        leaseOwner: input.workerId,
        leaseToken: this.uuid.next(),
      };
      this.messages.set(leased.outboxMessageId, leased);
      claimed.push(leased);
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
    const message = this.messages.get(input.outboxMessageId);
    if (message === undefined || message.state !== 'leased') {
      return false;
    }
    if (message.leaseOwner !== input.workerId || message.leaseToken !== input.leaseToken) {
      return false;
    }
    if (input.published) {
      this.messages.set(message.outboxMessageId, { ...message, state: 'published' });
      return true;
    }
    const nextState: 'pending' | 'dead_letter' =
      input.retryAt === undefined ? 'dead_letter' : 'pending';
    const availableAt = input.retryAt === undefined ? message.availableAt : input.retryAt;
    // Rebuilt without lease fields: exactOptionalPropertyTypes forbids assigning undefined.
    this.messages.set(message.outboxMessageId, {
      outboxMessageId: message.outboxMessageId,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      commandType: message.commandType,
      schemaVersion: message.schemaVersion,
      idempotencyKeyDigest: message.idempotencyKeyDigest,
      payloadDigest: message.payloadDigest,
      safePayload: message.safePayload,
      state: nextState,
      attempts: message.attempts,
      availableAt,
    });
    // Mirrors app_private.finish_outbox (migration 202610060003): true whenever the lease
    // held and the row was updated — including the retry (pending) and dead-letter paths.
    // The worker counts false as a LOST lease, so the outcome must be reported honestly.
    return true;
  }
}

// Append-only payment event log (TICKET-006 scenario seam) ------------------------

export interface MemoryPaymentEventRecord extends PaymentEventAppend {
  readonly eventId: string;
}

/**
 * In-memory append-only payment event log (TICKET-006). It mirrors the reviewed
 * persistence behavior: appends are idempotent per (source_system, external_event_id)
 * — migration 202610060002's partial unique index — and the log is never updated or
 * deleted. The TICKET-005 worker writes TransferSubmissionRecorded / TransferReconciled
 * events through the repository port; the scenario projector reads them back.
 */
export class MemoryPaymentEventStore
  implements PaymentEventRepository, SubmissionEvidenceRepository
{
  private readonly events: MemoryPaymentEventRecord[] = [];

  constructor(private readonly uuid: UuidGenerator) {}

  async appendEvent(event: PaymentEventAppend): Promise<string> {
    if (event.externalEventId !== undefined) {
      const existing = this.events.find(
        (stored) =>
          stored.sourceSystem === event.sourceSystem &&
          stored.externalEventId === event.externalEventId,
      );
      if (existing !== undefined) {
        // Mirrors ON CONFLICT (source_system, external_event_id) DO NOTHING: the same
        // evidence is never recorded twice.
        return existing.eventId;
      }
    }
    const eventId = this.uuid.next();
    this.events.push({ ...event, eventId });
    return eventId;
  }

  async findSubmissionByOutboxMessage(
    paymentIntentId: string,
    outboxMessageId: string,
  ): Promise<OutboxSubmissionEvidence | null> {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (
        event === undefined ||
        event.eventType !== WORKER_SUBMISSION_EVENT.eventType ||
        event.sourceSystem !== WORKER_SUBMISSION_EVENT.sourceSystem ||
        event.paymentIntentId !== paymentIntentId
      ) {
        continue;
      }
      const metadata = event.safeMetadata as Record<string, unknown>;
      if (metadata['outbox_message_id'] !== outboxMessageId) {
        continue;
      }
      const externalTransferId = metadata['external_transfer_id'];
      const outcome = metadata['outcome'];
      if (typeof externalTransferId !== 'string') {
        continue;
      }
      if (outcome !== 'committed' && outcome !== 'rejected' && outcome !== 'timeout_unknown') {
        continue;
      }
      return { outboxMessageId, externalTransferId, outcome };
    }
    return null;
  }

  async findReconciliationByExternalId(
    externalTransferId: string,
  ): Promise<ReconciliationEvidence | null> {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (
        event === undefined ||
        event.eventType !== WORKER_RECONCILIATION_EVENT.eventType ||
        event.sourceSystem !== WORKER_RECONCILIATION_EVENT.sourceSystem
      ) {
        continue;
      }
      const metadata = event.safeMetadata as Record<string, unknown>;
      if (metadata['external_transfer_id'] !== externalTransferId) {
        continue;
      }
      const queryStatus = metadata['query_status'];
      if (queryStatus !== 'committed' && queryStatus !== 'rejected') {
        continue;
      }
      return { externalTransferId, resolvedStatus: queryStatus };
    }
    return null;
  }

  /** Ordered scenario reads (TICKET-006): the full append-only log for one intent. */
  listForIntent(paymentIntentId: string): readonly MemoryPaymentEventRecord[] {
    return this.events.filter((event) => event.paymentIntentId === paymentIntentId);
  }
}

/** Serializes each command with its outbox enqueue in one (here trivially atomic) unit. */
export class MemoryTransaction implements TransactionBoundary {
  async run<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
