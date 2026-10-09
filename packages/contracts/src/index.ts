import type { PaymentState } from '@eeeasy-pay/domain';

/**
 * Closed set of stable, safe problem codes (RFC 7807-style problem details). Do not add
 * codes that leak internals, partner names, or scheme details.
 */
export const PROBLEM_CODES = [
  'validation_error',
  'unauthenticated',
  'forbidden',
  'not_found',
  'quote_expired',
  'quote_not_bound',
  'state_conflict',
  'idempotency_conflict',
  'rate_limited',
  'unsupported_currency',
  'simulator_limit',
  'needs_reconciliation',
  'internal_error',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface ProblemDetail {
  readonly type: string;
  readonly title: string;
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly correlationId: string;
  readonly instance?: string;
}

// V1 request/response shapes ---------------------------------------------------

export interface CreatePaymentIntentRequestV1 {
  readonly sourceBankLinkId: string;
  readonly recipientAliasId: string;
  /** Uppercase 3-letter placeholder set until the partner profile fixes it (B-08). */
  readonly currency: string;
  /** Decimal string of exact minor units (never a float). */
  readonly amountMinor: string;
  /** Untrusted correlation input; the server fingerprint is authoritative (ADR-005). */
  readonly idempotencyKey?: string;
  /** Set when this payment pays a split share. */
  readonly splitShareId?: string;
}

export interface QuoteV1 {
  readonly quoteId: string;
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: string;
  readonly quotedFeeMinor: string;
  readonly payerDebitMinor: string;
  readonly recipientAmountMinor: string;
  readonly feeRuleVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Read-only projection (ADR-007): 'expired' never means the payment row was mutated. */
export type QuoteStatusProjectionV1 = 'valid' | 'expired' | 'unavailable';

export interface PaymentIntentV1 {
  readonly paymentIntentId: string;
  readonly state: PaymentState;
  readonly currency: string;
  readonly requestedAmountMinor: string;
  readonly quote?: QuoteV1;
  readonly quoteStatus: QuoteStatusProjectionV1;
  readonly canConfirm: boolean;
  /** Always explicit in simulator mode; never displayed as a real transfer. */
  readonly evidenceSource?: 'SIMULATOR';
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Product-facing status labels. They deliberately distinguish submitted, processing,
 * unknown/needs-reconciliation, recipient credited (simulated), and settlement (simulated)
 * so simulated evidence can never be labeled as a real transfer (GUARDRAILS.md #7).
 */
export type PaymentStatusLabelV1 =
  | 'submitted'
  | 'processing'
  | 'unknown_needs_reconciliation'
  | 'recipient_credited_simulated'
  | 'settlement_simulated'
  | 'rejected'
  | 'expired'
  | 'manual_resolution';

export type SettlementStateV1 = 'not_applicable' | 'pending' | 'settled' | 'exception' | 'unknown';

export function statusLabelFor(
  state: PaymentState,
  settlementState: SettlementStateV1,
): PaymentStatusLabelV1 {
  if (state === 'completed') {
    // Settlement evidence is a SEPARATE dimension; in simulator mode it is only ever simulated.
    return settlementState === 'settled' ? 'settlement_simulated' : 'recipient_credited_simulated';
  }
  switch (state) {
    case 'created':
    case 'lookup_pending':
    case 'quoting':
    case 'quoted':
      return 'submitted';
    case 'user_authorized':
    case 'transfer_submitted':
    case 'transfer_processing':
    case 'transfer_prepared':
    case 'transfer_committed':
    case 'recipient_credit_pending':
      return 'processing';
    case 'unknown_reconciliation':
    case 'compensation_pending':
      return 'unknown_needs_reconciliation';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    case 'manual_resolution':
      return 'manual_resolution';
  }
}

export interface PaymentStatusV1 {
  readonly paymentIntentId: string;
  readonly state: PaymentState;
  readonly statusLabel: PaymentStatusLabelV1;
  readonly settlementState: SettlementStateV1;
  readonly simulatorNote?: 'simulated only: no bank debit, scheme transfer, or settlement occurred';
}

export interface SplitBillV1 {
  readonly splitBillId: string;
  readonly title: string;
  readonly currency: string;
  readonly totalMinor: string;
  readonly splitState: 'draft' | 'open' | 'closed' | 'cancelled';
  readonly roundingPolicy: 'explicit_minor_units' | 'remainder_to_first_share';
  readonly closesAt?: string;
  readonly createdAt: string;
}

export interface SplitShareV1 {
  readonly splitShareId: string;
  readonly splitBillId: string;
  readonly amountMinor: string;
  readonly shareState:
    'unpaid' | 'payment_pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'needs_review';
  readonly expiresAt?: string;
  readonly createdAt: string;
}

/**
 * Invite claim is NOT a payment authorization (GUARDRAILS.md #4): claiming only binds the
 * authenticated actor to the share, one time, atomically, with its own expiry.
 */
export interface ClaimInviteRequestV1 {
  readonly splitShareId: string;
  readonly inviteToken: string;
}

export interface ClaimInviteResponseV1 {
  readonly splitShareId: string;
  readonly result: 'claimed' | 'already_claimed';
}
