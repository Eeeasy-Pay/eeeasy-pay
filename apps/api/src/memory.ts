// In-memory repository implementations for the simulator-only product API (TICKET-003).
// They exist so the HTTP layer has narrow, ports-shaped seams; TICKET-004 replaces them
// with Postgres repositories over the reviewed migrations. Synchronous Map storage makes
// each transaction trivially atomic here; the Postgres versions must use real
// transactional boundaries (ADR-006), including durable outbox claiming with leases.

import type { QuoteV1 } from '@eeeasy-pay/contracts';
import type { QuoteBindingTerms } from '@eeeasy-pay/pal';
import type {
  Clock,
  IdempotencyReplay,
  IdempotencyRepository,
  OutboxMessageRecord,
  OutboxRepository,
  PaymentIntentRecord,
  PaymentIntentRepository,
  TransactionBoundary,
  UuidGenerator,
} from '@eeeasy-pay/ports';

export interface IntentRecord extends PaymentIntentRecord {
  readonly createdAt: string;
  readonly updatedAt: string;
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
    return false;
  }
}

/** Serializes each command with its outbox enqueue in one (here trivially atomic) unit. */
export class MemoryTransaction implements TransactionBoundary {
  async run<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
