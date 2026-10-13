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
  TransferCommitted | TransferRejected | TransferTimeoutUnknown;

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
  claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<OutboxMessageRecord[]>;
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

// Quote persistence (TICKET-004) ------------------------------------------------

/** Stored quote terms. Digests are hex strings; amounts are exact integer minor units. */
export interface QuoteRecord {
  readonly quoteId: string;
  readonly paymentIntentId: string;
  readonly providerKey: string;
  readonly partnerQuoteRef: string;
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly quotedFeeMinor: bigint;
  readonly payerDebitMinor: bigint;
  readonly recipientAmountMinor: bigint;
  readonly feeRuleVersion: string;
  /** SHA-256 over the canonical quote terms (mirrors payment_quotes.binding_hash). */
  readonly bindingDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface QuoteInsert {
  readonly quoteId: string;
  readonly paymentIntentId: string;
  readonly providerKey: string;
  readonly partnerQuoteRef: string;
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: bigint;
  readonly quotedFeeMinor: bigint;
  readonly payerDebitMinor: bigint;
  readonly recipientAmountMinor: bigint;
  readonly feeRuleVersion: string;
  /** SHA-256 over the request that produced the quote (mirrors request_fingerprint). */
  readonly requestFingerprintDigest: string;
  readonly bindingDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface QuoteRepository {
  insertQuote(quote: QuoteInsert): Promise<void>;
  findQuoteById(quoteId: string): Promise<QuoteRecord | null>;
}

// Append-only payment event log (TICKET-004) --------------------------------------

export interface PaymentEventAppend {
  readonly paymentIntentId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly sourceSystem: string;
  readonly externalEventId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt?: string;
  readonly previousState?: PaymentState;
  readonly nextState?: PaymentState;
  readonly payloadDigest: string;
  readonly privacyClass: 'operational_minimal' | 'sensitive_reference';
  readonly safeMetadata: Readonly<Record<string, unknown>>;
}

export interface PaymentEventRepository {
  /** Append-only (payment_events is never updated or deleted). Returns the event id. */
  appendEvent(event: PaymentEventAppend): Promise<string>;
}

// Quote-bound confirmation command (TICKET-004, ADR-006) ---------------------------

export interface ConfirmPaymentIntentCommand {
  readonly actorId: string;
  readonly paymentIntentId: string;
  readonly quoteId: string;
  readonly quoteBindingDigest: string;
  readonly requestDigest: string;
  readonly idempotencyKeyDigest: string;
  readonly authorizationEvidenceRef: string;
  readonly correlationId: string;
}

export interface ConfirmPaymentIntentOutcome {
  readonly replayed: boolean;
  readonly paymentIntentId: string | null;
  readonly state: string;
}

/**
 * Atomic confirmation: idempotency record, intent projection, append-only event, and the
 * durable outbox command commit in ONE database transaction
 * (app_private.confirm_payment_intent, migration 202610060003).
 */
export interface PaymentCommandPort {
  confirmPaymentIntent(command: ConfirmPaymentIntentCommand): Promise<ConfirmPaymentIntentOutcome>;
}

// Split invite redemption (TICKET-004) ---------------------------------------------

export interface SplitInviteClaimPort {
  /** 'claimed' on first redemption, 'already_claimed' when the same actor redeems again. */
  claimInvite(input: {
    readonly actorId: string;
    readonly splitShareId: string;
    readonly inviteTokenDigest: string;
  }): Promise<'claimed' | 'already_claimed'>;
}

// Worker outbox/inbox processing (TICKET-005) ------------------------------------

/**
 * Event naming contract shared by apps/worker (writes) and packages/persistence
 * (reconciliation reads). External event ids are unique per source_system
 * (migration 202610060002), so these pairs also make the appends idempotent.
 */
export const WORKER_SUBMISSION_EVENT = {
  eventType: 'TransferSubmissionRecorded',
  sourceSystem: 'worker-submission',
} as const;

export const WORKER_RECONCILIATION_EVENT = {
  eventType: 'TransferReconciled',
  sourceSystem: 'worker-reconciliation',
} as const;

/** A recorded external transfer submission for an outbox message (append-only log read). */
export interface OutboxSubmissionEvidence {
  readonly outboxMessageId: string;
  readonly externalTransferId: string;
  readonly outcome: 'committed' | 'rejected' | 'timeout_unknown';
}

/** A completed reconciliation of an ambiguous submission (query of the ORIGINAL external id). */
export interface ReconciliationEvidence {
  readonly externalTransferId: string;
  readonly resolvedStatus: 'committed' | 'rejected';
}

/**
 * Reads the append-only payment event log for worker submission and reconciliation
 * records, so the outbox worker can reconcile the ORIGINAL external id after a
 * timeout_unknown outcome or a crash between submission and completion (ADR-006).
 */
export interface SubmissionEvidenceRepository {
  /** Latest submission recorded for this outbox message, or null when none was recorded. */
  findSubmissionByOutboxMessage(
    paymentIntentId: string,
    outboxMessageId: string,
  ): Promise<OutboxSubmissionEvidence | null>;
  /** Completed reconciliation for this external id, or null when it is still ambiguous. */
  findReconciliationByExternalId(
    externalTransferId: string,
  ): Promise<ReconciliationEvidence | null>;
}

/**
 * Inbox lifecycle for the trusted worker. Both writes are the granted service_role
 * UPDATE path on inbox_events (migration 202610060003); the mobile app never sees it
 * (GUARDRAILS.md #5).
 */
export interface InboxLifecycleRepository {
  /** Marks a deduplicated, ingested event processed (pairs state with processed_at). */
  markProcessed(inboxEventId: string): Promise<boolean>;
  /**
   * Quarantines the stored event whose (provider key, event id) was redelivered with a
   * changed payload hash (ADR-006). Idempotent: returns false when already quarantined.
   */
  quarantine(providerKey: string, providerEventId: string): Promise<boolean>;
}

// Typed command errors, mapped from database SQLSTATEs by packages/persistence ------

export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key reused with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class InboxPayloadConflictError extends Error {
  constructor() {
    super('provider event id reused with a different payload hash');
    this.name = 'InboxPayloadConflictError';
  }
}

export class QuoteNotBindableError extends Error {
  constructor() {
    super('quote missing, expired, or not bound to intent');
    this.name = 'QuoteNotBindableError';
  }
}

export class PaymentIntentNotFoundError extends Error {
  constructor() {
    super('payment intent not found for actor');
    this.name = 'PaymentIntentNotFoundError';
  }
}

export class PaymentStateConflictError extends Error {
  constructor() {
    super('payment is not confirmable in current state');
    this.name = 'PaymentStateConflictError';
  }
}

export class RouteIneligibleError extends Error {
  constructor() {
    super('source link or recipient alias is no longer eligible');
    this.name = 'RouteIneligibleError';
  }
}

export class InviteUnavailableError extends Error {
  constructor() {
    super('invite unavailable');
    this.name = 'InviteUnavailableError';
  }
}
