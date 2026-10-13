// Restart-safe outbox processor (TICKET-005, docs/implementation/TICKETS.md).
//
// The processor claims durable outbox commands through lease-based claiming and executes
// them against the sponsor DFSP boundary — in this repository the deterministic SIMULATOR
// connector only (GUARDRAILS.md #2; B-01 blocks any real adapter).
//
// Crash/restart safety: every external submission is recorded in the append-only payment
// event log under the ORIGINAL external transfer id before the outbox message can be
// released. After a timeout_unknown outcome — or a crash between submission and finish —
// the next attempt reconciles by QUERYING that original id and NEVER resubmits with a new
// one (ADR-006, GUARDRAILS.md #4). One window remains by contract: if the process dies
// between the external submission and the evidence append, no external id exists on our
// side; a real adapter closes that window with a partner-side idempotency key (the outbox
// digest), which the simulator does not model (recorded honestly as a B-01 concern).

import type {
  Clock,
  OutboxMessageRecord,
  OutboxRepository,
  PaymentEventAppend,
  PaymentEventRepository,
  SponsorDfspPort,
  SubmissionEvidenceRepository,
  TransferQueryOutcome,
  TransferSubmissionOutcome,
} from '@eeeasy-pay/ports';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import { canonicalize, sha256Hex } from '@eeeasy-pay/pal';

/** Append-only event writes plus the reconciliation reads the worker needs. */
export type WorkerEventStore = PaymentEventRepository & SubmissionEvidenceRepository;

export interface OutboxWorkerDeps {
  readonly outbox: OutboxRepository;
  readonly events: WorkerEventStore;
  readonly sponsor: SponsorDfspPort;
  readonly clock: Clock;
  readonly workerId: string;
}

export interface OutboxWorkerOptions {
  /** Messages per claim; app_private.claim_outbox allows 1..250. Default 25. */
  readonly claimLimit?: number;
  /** Lease length in seconds; app_private.claim_outbox allows 5..3600. Default 60. */
  readonly leaseSeconds?: number;
  /** Ascending retry backoff, indexed from the first retry. Default 5s/15s/60s/5m/15m. */
  readonly retryBackoffMs?: readonly number[];
  /** Total claims after which an unresolved message dead-letters. Default 6. */
  readonly maxAttempts?: number;
}

/** One batch of claimed outbox messages and how each message ended. */
export interface BatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly pendingRetry: number;
  readonly deadLettered: number;
  /** finish() refused the completion: the lease expired and another claim took over. */
  readonly leaseLost: number;
}

/** The safe_payload shape of the durable `submit_payment` command (confirm_payment_intent). */
export interface SubmitPaymentPayload {
  readonly paymentIntentId: string;
  readonly quoteId: string;
  readonly quoteBindingDigest: string;
  readonly correlationId: string;
}

export const SUBMIT_PAYMENT_COMMAND = 'submit_payment' as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export function parseSubmitPaymentPayload(
  safePayload: Readonly<Record<string, unknown>>,
): SubmitPaymentPayload | null {
  const paymentIntentId = safePayload['payment_intent_id'];
  const quoteId = safePayload['quote_id'];
  const quoteBindingDigest = safePayload['quote_binding_sha256'];
  const correlationId = safePayload['correlation_id'];
  if (
    typeof paymentIntentId !== 'string' ||
    typeof quoteId !== 'string' ||
    typeof quoteBindingDigest !== 'string' ||
    typeof correlationId !== 'string'
  ) {
    return null;
  }
  if (!UUID_RE.test(paymentIntentId) || !UUID_RE.test(quoteId) || !UUID_RE.test(correlationId)) {
    return null;
  }
  if (!HEX64_RE.test(quoteBindingDigest)) {
    return null;
  }
  return { paymentIntentId, quoteId, quoteBindingDigest, correlationId };
}

type Disposition = 'published' | 'pending_retry' | 'dead_letter' | 'lease_lost';

const EMPTY_BATCH: BatchResult = {
  claimed: 0,
  published: 0,
  pendingRetry: 0,
  deadLettered: 0,
  leaseLost: 0,
};

export class OutboxWorker {
  private readonly claimLimit: number;
  private readonly leaseSeconds: number;
  private readonly retryBackoffMs: readonly number[];
  private readonly maxAttempts: number;

  constructor(
    private readonly deps: OutboxWorkerDeps,
    options: OutboxWorkerOptions = {},
  ) {
    this.claimLimit = options.claimLimit ?? 25;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.retryBackoffMs = options.retryBackoffMs ?? [5_000, 15_000, 60_000, 300_000, 900_000];
    this.maxAttempts = options.maxAttempts ?? 6;
  }

  /** Claims and processes one batch of outbox messages. */
  async runBatch(): Promise<BatchResult> {
    const messages = await this.deps.outbox.claim({
      workerId: this.deps.workerId,
      limit: this.claimLimit,
      leaseSeconds: this.leaseSeconds,
    });
    let published = 0;
    let pendingRetry = 0;
    let deadLettered = 0;
    let leaseLost = 0;
    for (const message of messages) {
      let disposition: Disposition;
      try {
        disposition = await this.processMessage(message);
      } catch {
        // Repository failure while completing: the lease expires on its own and the
        // message is reclaimed safely later. Counted as unfinished, never as published.
        disposition = 'lease_lost';
      }
      switch (disposition) {
        case 'published':
          published += 1;
          break;
        case 'pending_retry':
          pendingRetry += 1;
          break;
        case 'dead_letter':
          deadLettered += 1;
          break;
        default:
          leaseLost += 1;
          break;
      }
    }
    return { claimed: messages.length, published, pendingRetry, deadLettered, leaseLost };
  }

  /** Repeats runBatch until a batch claims nothing. Bounded by the dead-letter horizon. */
  async drain(): Promise<BatchResult> {
    const total: BatchResult = { ...EMPTY_BATCH };
    for (;;) {
      const batch = await this.runBatch();
      total.claimed += batch.claimed;
      total.published += batch.published;
      total.pendingRetry += batch.pendingRetry;
      total.deadLettered += batch.deadLettered;
      total.leaseLost += batch.leaseLost;
      if (batch.claimed === 0) {
        return total;
      }
    }
  }

  private async processMessage(message: OutboxMessageRecord): Promise<Disposition> {
    if (message.commandType !== SUBMIT_PAYMENT_COMMAND) {
      // Unknown commands are programming errors; retrying cannot fix them.
      return this.finish(message, false, undefined, 'unsupported_command_type');
    }
    const payload = parseSubmitPaymentPayload(message.safePayload);
    if (!payload) {
      return this.finish(message, false, undefined, 'invalid_safe_payload');
    }
    try {
      const prior = await this.deps.events.findSubmissionByOutboxMessage(
        payload.paymentIntentId,
        message.outboxMessageId,
      );
      if (prior) {
        return this.reconcilePriorSubmission(message, payload, prior.externalTransferId);
      }
      return this.submitNew(message, payload);
    } catch {
      // Evidence read or repository failure before any external submission happened.
      return this.finish(message, false, this.retryAt(message), 'processor_error');
    }
  }

  private async submitNew(
    message: OutboxMessageRecord,
    payload: SubmitPaymentPayload,
  ): Promise<Disposition> {
    let outcome: TransferSubmissionOutcome;
    try {
      outcome = await this.deps.sponsor.submitTransfer({
        paymentIntentId: payload.paymentIntentId,
        quoteId: payload.quoteId,
        quoteBindingDigest: payload.quoteBindingDigest,
        correlationId: payload.correlationId,
      });
    } catch {
      // SponsorDfspPort contract: submitTransfer throws only when NO submission happened.
      // A real adapter must never throw ambiguously after a submission (B-01).
      return this.finish(message, false, this.retryAt(message), 'submission_error');
    }
    try {
      await this.recordSubmission(message, payload, outcome);
    } catch {
      // The external submission happened but its evidence could not be recorded. A retry
      // would resubmit with a NEW external id (an ADR-006 violation), so the message
      // dead-letters for explicit handling instead of auto-retrying.
      return this.finish(message, false, undefined, 'evidence_write_failed');
    }
    if (outcome.kind === 'timeout_unknown') {
      // The submission MIGHT have been committed: retry later and reconcile the
      // ORIGINAL external id; never resubmit with a new id (ADR-006).
      return this.finish(message, false, this.retryAt(message), 'timeout_unknown');
    }
    return this.finish(message, true);
  }

  private async reconcilePriorSubmission(
    message: OutboxMessageRecord,
    payload: SubmitPaymentPayload,
    externalTransferId: string,
  ): Promise<Disposition> {
    let query: TransferQueryOutcome;
    try {
      // NEVER resubmit: query the ORIGINAL external id (ADR-006, GUARDRAILS.md #4).
      query = await this.deps.sponsor.queryTransfer(externalTransferId);
    } catch {
      return this.finish(message, false, this.retryAt(message), 'reconciliation_error');
    }
    if (query.status === 'unknown') {
      return this.finish(message, false, this.retryAt(message), 'reconciliation_pending');
    }
    try {
      await this.recordReconciliation(message, payload, query);
    } catch {
      // The original external id stays recorded; dead-letter rather than risk rework.
      return this.finish(message, false, undefined, 'evidence_write_failed');
    }
    return this.finish(message, true);
  }

  private async recordSubmission(
    message: OutboxMessageRecord,
    payload: SubmitPaymentPayload,
    outcome: TransferSubmissionOutcome,
  ): Promise<void> {
    const externalTransferId =
      outcome.kind === 'rejected'
        ? (outcome.externalTransferId ?? null)
        : outcome.externalTransferId;
    const metadata: Record<string, unknown> = {
      outbox_message_id: message.outboxMessageId,
      outcome: outcome.kind,
      quote_id: payload.quoteId,
      ...(externalTransferId !== null ? { external_transfer_id: externalTransferId } : {}),
    };
    const event: PaymentEventAppend = {
      paymentIntentId: payload.paymentIntentId,
      eventType: WORKER_SUBMISSION_EVENT.eventType,
      schemaVersion: 1,
      sourceSystem: WORKER_SUBMISSION_EVENT.sourceSystem,
      ...(externalTransferId !== null ? { externalEventId: externalTransferId } : {}),
      correlationId: payload.correlationId,
      causationId: message.outboxMessageId,
      occurredAt: outcome.occurredAt,
      payloadDigest: sha256Hex(canonicalize(metadata)),
      privacyClass: 'operational_minimal',
      safeMetadata: metadata,
    };
    await this.deps.events.appendEvent(event);
  }

  private async recordReconciliation(
    message: OutboxMessageRecord,
    payload: SubmitPaymentPayload,
    query: TransferQueryOutcome,
  ): Promise<void> {
    // Idempotent: a crash between this append and finish() replays the same path and the
    // existing reconciliation record skips the duplicate append.
    const existing = await this.deps.events.findReconciliationByExternalId(
      query.externalTransferId,
    );
    if (existing) {
      return;
    }
    const metadata: Record<string, unknown> = {
      outbox_message_id: message.outboxMessageId,
      external_transfer_id: query.externalTransferId,
      query_status: query.status,
      ...(query.evidenceSource !== undefined
        ? {
            evidence_source: query.evidenceSource,
            ...(query.evidenceRef !== undefined ? { evidence_ref: query.evidenceRef } : {}),
          }
        : {}),
    };
    const event: PaymentEventAppend = {
      paymentIntentId: payload.paymentIntentId,
      eventType: WORKER_RECONCILIATION_EVENT.eventType,
      schemaVersion: 1,
      sourceSystem: WORKER_RECONCILIATION_EVENT.sourceSystem,
      externalEventId: query.externalTransferId,
      correlationId: payload.correlationId,
      causationId: message.outboxMessageId,
      occurredAt: query.occurredAt,
      payloadDigest: sha256Hex(canonicalize(metadata)),
      privacyClass: 'operational_minimal',
      safeMetadata: metadata,
    };
    await this.deps.events.appendEvent(event);
  }

  /** Retry time for the next attempt, or undefined when the dead-letter horizon is reached. */
  private retryAt(message: OutboxMessageRecord): string | undefined {
    if (message.attempts >= this.maxAttempts) {
      return undefined;
    }
    const index = Math.min(Math.max(message.attempts - 1, 0), this.retryBackoffMs.length - 1);
    const backoff = this.retryBackoffMs[index];
    if (backoff === undefined) {
      return undefined;
    }
    return new Date(this.deps.clock.now().getTime() + backoff).toISOString();
  }

  private async finish(
    message: OutboxMessageRecord,
    published: boolean,
    retryAt: string | undefined,
    errorCode: string | undefined,
  ): Promise<Disposition> {
    if (message.leaseToken === undefined) {
      return 'lease_lost';
    }
    const input: {
      outboxMessageId: string;
      workerId: string;
      leaseToken: string;
      published: boolean;
      retryAt?: string;
      errorCode?: string;
    } = {
      outboxMessageId: message.outboxMessageId,
      workerId: this.deps.workerId,
      leaseToken: message.leaseToken,
      published,
    };
    if (retryAt !== undefined) {
      input.retryAt = retryAt;
    }
    if (errorCode !== undefined) {
      input.errorCode = errorCode;
    }
    const finished = await this.deps.outbox.finish(input);
    if (!finished) {
      return 'lease_lost';
    }
    return published ? 'published' : retryAt === undefined ? 'dead_letter' : 'pending_retry';
  }
}
