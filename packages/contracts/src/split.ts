import { z } from 'zod';
import {
  CurrencySchema,
  PositiveMinorSchema,
  TimestampSchema,
  UuidSchema,
} from './shared.ts';

export const SPLIT_BILL_STATES = ['draft', 'open', 'closed', 'cancelled'] as const;
export const SplitBillStateV1Schema = z.enum(SPLIT_BILL_STATES);
export type SplitBillStateV1 = z.infer<typeof SplitBillStateV1Schema>;

export const ROUNDING_POLICIES = ['explicit_minor_units', 'remainder_to_first_share'] as const;
export const RoundingPolicyV1Schema = z.enum(ROUNDING_POLICIES);
export type RoundingPolicyV1 = z.infer<typeof RoundingPolicyV1Schema>;

export const SPLIT_SHARE_STATES = [
  'unpaid',
  'payment_pending',
  'paid',
  'failed',
  'expired',
  'cancelled',
  'needs_review',
] as const;
export const SplitShareStateV1Schema = z.enum(SPLIT_SHARE_STATES);
export type SplitShareStateV1 = z.infer<typeof SplitShareStateV1Schema>;

export const SplitBillV1Schema = z.object({
  splitBillId: UuidSchema,
  title: z.string().min(1).max(255),
  currency: CurrencySchema,
  totalMinor: PositiveMinorSchema,
  splitState: SplitBillStateV1Schema,
  roundingPolicy: RoundingPolicyV1Schema,
  closesAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
});
export type SplitBillV1 = z.infer<typeof SplitBillV1Schema>;

export const SplitShareV1Schema = z.object({
  splitShareId: UuidSchema,
  splitBillId: UuidSchema,
  amountMinor: PositiveMinorSchema,
  shareState: SplitShareStateV1Schema,
  expiresAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
});
export type SplitShareV1 = z.infer<typeof SplitShareV1Schema>;

/** One share amount in a create request. Allocation rules live in packages/domain. */
export const ShareInputV1Schema = z.object({ amountMinor: PositiveMinorSchema });
export type ShareInputV1 = z.infer<typeof ShareInputV1Schema>;

export const CreateSplitBillRequestV1Schema = z.object({
  title: z.string().min(1).max(255),
  currency: CurrencySchema,
  totalMinor: PositiveMinorSchema,
  roundingPolicy: RoundingPolicyV1Schema,
  closesAt: TimestampSchema.optional(),
  shares: z.array(ShareInputV1Schema).min(2).max(100),
});
export type CreateSplitBillRequestV1 = z.infer<typeof CreateSplitBillRequestV1Schema>;

export const SplitBillCreatedResponseV1Schema = z.object({
  splitBill: SplitBillV1Schema,
  shares: z.array(SplitShareV1Schema),
});
export type SplitBillCreatedResponseV1 = z.infer<typeof SplitBillCreatedResponseV1Schema>;

export const SplitShareListV1Schema = z.object({ shares: z.array(SplitShareV1Schema) });
export type SplitShareListV1 = z.infer<typeof SplitShareListV1Schema>;

/**
 * Invite claim is NOT a payment authorization (GUARDRAILS.md #4): claiming only binds the
 * authenticated actor to the share, one time, atomically, with its own expiry.
 */
export const ClaimInviteRequestV1Schema = z.object({
  splitShareId: UuidSchema,
  inviteToken: z.string().min(1).max(255),
});
export type ClaimInviteRequestV1 = z.infer<typeof ClaimInviteRequestV1Schema>;

export const ClaimInviteResponseV1Schema = z.object({
  splitShareId: UuidSchema,
  result: z.enum(['claimed', 'already_claimed']),
});
export type ClaimInviteResponseV1 = z.infer<typeof ClaimInviteResponseV1Schema>;
