import type { PaymentState } from '@eeeasy-pay/domain';

// Primitives -----------------------------------------------------------------

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export interface UuidGenerator {
  next(): string;
}

// Sponsor DFSP boundary --------------------------------------------------------
// Product-owned interface for the operations the PAL needs from the sponsoring DFSP,
// with EXPLICIT outcome and evidence types. Nothing here implies bank credit or
// settlement by itself (GUARDRAILS.md #2, #3). This interface is internal to this
// product and is NOT a claim about the SDK Scheme Adapter's universal API (ADR-008).
// The only implementation in this repository is the simulator; a real adapter is
// blocked on the signed scheme/partner profile (OPEN_DECISIONS.md B-01).

export interface QuoteRequest {
  readonly paymentIntentId: string;
  readonly correlationId: string;
  /** Placeholder currency set until the partner profile fixes it (B-08). */
  readonly currency: string;
  /** Exact integer minor units. */
  readonly requestedAmountMinor: bigint;
}

export interface QuoteOutcome {
  readonly providerKey: string;
  /** Opaque partner reference. Never parsed or interpreted by product code. */
  readonly partnerQuoteRef: string;
  /** 'SIMULATOR' in this repository; real profiles come from B-01. */
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly quotedFeeMinor: bigint;
  readonly payerDebitMinor: bigint;
  readonly recipientAmountMinor: bigint;
  readonly feeRuleVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface TransferCommand {
  readonly paymentIntentId: string;
  readonly quoteId: string;
  /** Hex digest tying the submission to the exact confirmed quote terms. */
  readonly quoteBindingDigest: string;
  readonly correlationId: string;
}

export interface TransferCommitted {
  readonly kind: 'committed';
  /** Reuse this EXACT id for every later query about this operation. */
  readonly externalTransferId: string;
  readonly evidenceSource: 'SIMULATOR';
  readonly evidenceRef: string;
  readonly occurredAt: string;
}

export interface TransferRejected {
  readonly kind: 'rejected';
  readonly externalTransferId?: string;
  /** Simulator-only reason codes; never invented partner codes. */
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface TransferTimeoutUnknown {
  readonly kind: 'timeout_unknown';
  /**
   * The submission MIGHT have been committed. The caller MUST query/reconcile the
   * ORIGINAL external id and MUST NEVER resubmit with a new id (ADR-006).
   */
  readonly externalTransferId: string;
  readonly occurredAt: string;
}

export type TransferSubmissionOutcome =
  | TransferCommitted
  | TransferRejected
  | TransferTimeoutUnknown;

export type TransferQueryStatus = 'committed' | 'rejected' | 'unknown';

export interface TransferQueryOutcome {
  readonly externalTransferId: string;
  readonly status: TransferQueryStatus;
  readonly evidenceSource?: 'SIMULATOR';
  readonly evidenceRef?: string;
  readonly occurredAt: string;
}

export interface SponsorDfspPort {
  quote(request: QuoteRequest): Promise<QuoteOutcome>;
  submitTransfer(command: TransferCommand): Promise<TransferSubmissionOutcome>;
  queryTransfer(externalTransferId: string): Promise<TransferQueryOutcome>;
}

// Notification (simulated only, B-05) -----------------------------------------

export interface SimulatedNotification {
  readonly userId: string;
  /** Stable template code; never raw phone numbers or bank data. */
  readonly template: string;
  /** Pre-redacted values only. */
  readonly params: Readonly<Record<string, string>>;
}

export interface NotificationPort {
  notify(notification: SimulatedNotification): Promise<void>;
}

// Narrow repository ports ------------------------------------------------------
// Shapes are provisional and finalized in TICKET-004 together with packages/persistence.

export interface IdempotencyReplay {
  readonly replayed: boolean;
  readonly requestMatched: boolean;
  readonly resourceRef?: string;
}

export interface IdempotencyRepository {
  reserve(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
    resourceRef?: string;
  }): Promise<IdempotencyReplay>;
  markAccepted(input: { actorId: string; operation: string; keyDigest: string }): Promise<void>;
  markCompleted(input: { actorId: string; operation: string; keyDigest: string }): Promise<void>;
  markFailed(input: { actorId: string; operation: string; keyDigest: string }): Promise<void>;
}

export interface PaymentIntentRecord {
  readonly paymentIntentId: string;
  readonly actorId: string;
  readonly state: PaymentState;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly currentQuoteId?: string;
}

export interface PaymentIntentRepository {
  findById(paymentIntentId: string): Promise<PaymentIntentRecord | null>;
  findOwnedById(paymentIntentId: string, actorId: string): Promise<PaymentIntentRecord | null>;
}

export interface OutboxMessageRecord {
  readonly outboxMessageId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly commandType: string;
  readonly schemaVersion: number;
  readonly idempotencyKeyDigest: string;
  readonly payloadDigest: string;
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly state: 'pending' | 'leased' | 'published' | 'dead_letter';
  readonly attempts: number;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly availableAt: string;
}

export interface OutboxRepository {
  /** Enqueue inside the SAME transaction as the command that produced it (ADR-006). */
  enqueue(input: {
    aggregateType: string;
    aggregateId: string;
    commandType: string;
    schemaVersion: number;
    idempotencyKeyDigest: string;
    payloadDigest: string;
    safePayload: Readonly<Record<string, unknown>>;
  }): Promise<string>;
  claim(input: { workerId: string; limit: number; leaseSeconds: number }): Promise<OutboxMessageRecord[]>;
  finish(input: {
    outboxMessageId: string;
    workerId: string;
    leaseToken: string;
    published: boolean;
    retryAt?: string;
    errorCode?: string;
  }): Promise<boolean>;
}

export interface InboxRepository {
  /**
   * Deduplicates on (providerKey, providerEventId) + payload digest. The implementation
   * MUST reject or quarantine a changed payload under the same event id (ADR-006).
   */
  ingest(event: {
    providerKey: string;
    providerEventId: string;
    payloadDigest: string;
    schemaVersion: number;
    paymentIntentId?: string;
    correlationId?: string;
    authenticatedPrincipal: string;
    normalizedPayload: Readonly<Record<string, unknown>>;
  }): Promise<{ inboxEventId: string; replayed: boolean }>;
}

/**
 * Serializes a command with its outbox enqueue in one database transaction (ADR-006).
 */
export interface TransactionBoundary {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
