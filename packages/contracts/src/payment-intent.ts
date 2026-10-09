import { z } from 'zod';
import { PAYMENT_STATES } from '@eeeasy-pay/domain';
import type { PaymentState } from '@eeeasy-pay/domain';
import {
  CurrencySchema,
  NonNegativeMinorSchema,
  PositiveMinorSchema,
  TimestampSchema,
  UuidSchema,
} from './shared.ts';

// Closed enum sources ------------------------------------------------------------
// These arrays are the single source for the Zod schemas AND the OpenAPI document; CI
// cross-checks both mirrors against them (openapi.test.ts).

/** Read-only projection (ADR-007): 'expired' never means the payment row was mutated. */
export const QUOTE_STATUS_PROJECTIONS = ['valid', 'expired', 'unavailable'] as const;
export const QuoteStatusProjectionV1Schema = z.enum(QUOTE_STATUS_PROJECTIONS);
export type QuoteStatusProjectionV1 = z.infer<typeof QuoteStatusProjectionV1Schema>;

/**
 * Product-facing status labels (GUARDRAILS.md #7). They deliberately distinguish
 * submitted, processing, unknown/needs-reconciliation, recipient credited (simulated),
 * and settlement (simulated), so simulated evidence can never be labeled as a real
 * transfer.
 */
export const PAYMENT_STATUS_LABELS = [
  'submitted',
  'processing',
  'unknown_needs_reconciliation',
  'recipient_credited_simulated',
  'settlement_simulated',
  'rejected',
  'expired',
  'manual_resolution',
] as const;
export const PaymentStatusLabelV1Schema = z.enum(PAYMENT_STATUS_LABELS);
export type PaymentStatusLabelV1 = z.infer<typeof PaymentStatusLabelV1Schema>;

export const SETTLEMENT_STATES = [
  'not_applicable',
  'pending',
  'settled',
  'exception',
  'unknown',
] as const;
export const SettlementStateV1Schema = z.enum(SETTLEMENT_STATES);
export type SettlementStateV1 = z.infer<typeof SettlementStateV1Schema>;

// Requests / responses ------------------------------------------------------------

export const CreatePaymentIntentRequestV1Schema = z.object({
  sourceBankLinkId: UuidSchema,
  recipientAliasId: z.string().min(1).max(255),
  /** Uppercase 3-letter placeholder set until the partner profile fixes it (B-08). */
  currency: CurrencySchema,
  /** Decimal string of exact minor units (never a float). */
  amountMinor: PositiveMinorSchema,
  /** Untrusted correlation input; the server fingerprint is authoritative (ADR-005). */
  idempotencyKey: z.string().min(1).max(255).optional(),
  /** Set when this payment pays a split share. */
  splitShareId: UuidSchema.optional(),
});
export type CreatePaymentIntentRequestV1 = z.infer<typeof CreatePaymentIntentRequestV1Schema>;

export const QuoteV1Schema = z.object({
  quoteId: UuidSchema,
  apiProfile: z.string().min(1),
  currency: CurrencySchema,
  requestedAmountMinor: PositiveMinorSchema,
  quotedFeeMinor: NonNegativeMinorSchema,
  payerDebitMinor: PositiveMinorSchema,
  recipientAmountMinor: PositiveMinorSchema,
  feeRuleVersion: z.string().min(1),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type QuoteV1 = z.infer<typeof QuoteV1Schema>;

export const PaymentIntentV1Schema = z.object({
  paymentIntentId: UuidSchema,
  state: z.enum(PAYMENT_STATES),
  currency: CurrencySchema,
  requestedAmountMinor: PositiveMinorSchema,
  quote: QuoteV1Schema.optional(),
  quoteStatus: QuoteStatusProjectionV1Schema,
  canConfirm: z.boolean(),
  /** Always explicit in simulator mode; never displayed as a real transfer. */
  evidenceSource: z.literal('SIMULATOR').optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type PaymentIntentV1 = z.infer<typeof PaymentIntentV1Schema>;

export const PaymentStatusV1Schema = z.object({
  paymentIntentId: UuidSchema,
  state: z.enum(PAYMENT_STATES),
  statusLabel: PaymentStatusLabelV1Schema,
  settlementState: SettlementStateV1Schema,
  simulatorNote: z
    .literal('simulated only: no bank debit, scheme transfer, or settlement occurred')
    .optional(),
});
export type PaymentStatusV1 = z.infer<typeof PaymentStatusV1Schema>;

/** Accepted confirm command (HTTP 202). The outcome arrives via status reads. */
export const ConfirmResponseV1Schema = z.object({
  paymentIntentId: UuidSchema,
  accepted: z.literal(true),
  statusLabel: PaymentStatusLabelV1Schema,
});
export type ConfirmResponseV1 = z.infer<typeof ConfirmResponseV1Schema>;

export function statusLabelFor(
  state: PaymentState,
  settlementState: SettlementStateV1,
): PaymentStatusLabelV1 {
  if (state === 'completed') {
    // Settlement evidence is a SEPARATE dimension; in simulator mode it is only ever
    // simulated, so it is never labeled as a real transfer.
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
