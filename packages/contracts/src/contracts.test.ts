import { describe, expect, it } from 'vitest';
import { PAYMENT_STATES } from '@eeeasy-pay/domain';
import {
  ClaimInviteRequestV1Schema,
  CreatePaymentIntentRequestV1Schema,
  CreateSplitBillRequestV1Schema,
  PaymentIntentV1Schema,
  PaymentStatusV1Schema,
  ProblemDetailSchema,
  PROBLEM_CODES,
  PROBLEM_STATUSES,
  QuoteV1Schema,
  statusLabelFor,
} from './index.ts';

const validCreateRequest = {
  sourceBankLinkId: '0b6f1f6e-5e93-4d3f-8b3a-9db21a34a3f5',
  recipientAliasId: 'alias-24911',
  currency: 'SDG',
  amountMinor: '15000',
};

const validQuote = {
  quoteId: 'c2b6a1e0-0000-4000-8000-000000000001',
  apiProfile: 'simulator.v1',
  currency: 'SDG',
  requestedAmountMinor: '15000',
  quotedFeeMinor: '250',
  payerDebitMinor: '15250',
  recipientAmountMinor: '15000',
  feeRuleVersion: 'sim-fee-1',
  issuedAt: '2026-10-09T10:00:00.000Z',
  expiresAt: '2026-10-09T10:05:00.000Z',
};

const validPaymentIntent = {
  paymentIntentId: '11111111-2222-4333-8444-555555555555',
  state: 'quoted',
  currency: 'SDG',
  requestedAmountMinor: '15000',
  quote: validQuote,
  quoteStatus: 'valid',
  canConfirm: true,
  evidenceSource: 'SIMULATOR',
  createdAt: '2026-10-09T10:00:00.000Z',
  updatedAt: '2026-10-09T10:00:00.000Z',
};

describe('problem codes', () => {
  it('is a closed, duplicate-free set', () => {
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length);
    expect(PROBLEM_CODES).toContain('quote_expired');
  });

  it('problem statuses are a closed set', () => {
    expect(PROBLEM_STATUSES).toContain(409);
    expect(PROBLEM_STATUSES).not.toContain(200);
  });

  it('accepts a valid problem, rejects unknown codes and statuses', () => {
    const problem = {
      type: 'https://eeeasy-pay.example/problems/state-conflict',
      title: 'State conflict',
      status: 409,
      code: 'state_conflict',
      detail: 'The payment intent cannot be confirmed in its current state.',
      correlationId: '9f1d2b34-0000-4000-8000-000000000002',
    };
    expect(ProblemDetailSchema.parse(problem)).toEqual(problem);
    expect(ProblemDetailSchema.safeParse({ ...problem, code: 'bank_error' }).success).toBe(false);
    expect(ProblemDetailSchema.safeParse({ ...problem, status: 418 }).success).toBe(false);
  });
});

describe('CreatePaymentIntentRequestV1', () => {
  it('accepts a valid request', () => {
    expect(CreatePaymentIntentRequestV1Schema.parse(validCreateRequest)).toEqual(
      validCreateRequest,
    );
  });

  it('accepts the optional idempotency and split fields', () => {
    const parsed = CreatePaymentIntentRequestV1Schema.parse({
      ...validCreateRequest,
      idempotencyKey: 'rent-october',
      splitShareId: '33333333-4444-4555-8666-777777777777',
    });
    expect(parsed.idempotencyKey).toBe('rent-october');
    expect(parsed.splitShareId).toBeDefined();
  });

  it('rejects a missing source bank link', () => {
    const result = CreatePaymentIntentRequestV1Schema.safeParse({
      recipientAliasId: validCreateRequest.recipientAliasId,
      currency: validCreateRequest.currency,
      amountMinor: validCreateRequest.amountMinor,
    });
    expect(result.success).toBe(false);
  });

  it('rejects floats, leading zeros, zero and negative amounts', () => {
    for (const amountMinor of ['10.5', '007', '0', '-1']) {
      const result = CreatePaymentIntentRequestV1Schema.safeParse({
        ...validCreateRequest,
        amountMinor,
      });
      expect(result.success, amountMinor).toBe(false);
    }
  });

  it('rejects lowercase currency and non-uuid bank links', () => {
    const lower = CreatePaymentIntentRequestV1Schema.safeParse({
      ...validCreateRequest,
      currency: 'sdg',
    });
    expect(lower.success).toBe(false);
    const badLink = CreatePaymentIntentRequestV1Schema.safeParse({
      ...validCreateRequest,
      sourceBankLinkId: 'not-a-uuid',
    });
    expect(badLink.success).toBe(false);
  });
});

describe('QuoteV1', () => {
  it('accepts a valid quote', () => {
    expect(QuoteV1Schema.parse(validQuote)).toEqual(validQuote);
  });

  it('allows a zero fee, rejects negative fees and non-ISO timestamps', () => {
    expect(QuoteV1Schema.safeParse({ ...validQuote, quotedFeeMinor: '0' }).success).toBe(true);
    expect(QuoteV1Schema.safeParse({ ...validQuote, quotedFeeMinor: '-1' }).success).toBe(false);
    const naive = QuoteV1Schema.safeParse({ ...validQuote, issuedAt: '2026-10-09 10:00' });
    expect(naive.success).toBe(false);
  });
});

describe('PaymentIntentV1', () => {
  it('accepts a projection without a quote', () => {
    const projection = {
      paymentIntentId: '11111111-2222-4333-8444-555555555555',
      state: 'created',
      currency: 'SDG',
      requestedAmountMinor: '15000',
      quoteStatus: 'unavailable',
      canConfirm: false,
      createdAt: '2026-10-09T10:00:00.000Z',
      updatedAt: '2026-10-09T10:00:00.000Z',
    };
    expect(PaymentIntentV1Schema.parse(projection)).toEqual(projection);
  });

  it('accepts every domain payment state', () => {
    for (const state of PAYMENT_STATES) {
      const result = PaymentIntentV1Schema.safeParse({ ...validPaymentIntent, state });
      expect(result.success, state).toBe(true);
    }
  });

  it('rejects unknown states, quote statuses and partner evidence', () => {
    expect(
      PaymentIntentV1Schema.safeParse({ ...validPaymentIntent, state: 'settled_ok' }).success,
    ).toBe(false);
    expect(
      PaymentIntentV1Schema.safeParse({ ...validPaymentIntent, quoteStatus: 'maybe' }).success,
    ).toBe(false);
    expect(
      PaymentIntentV1Schema.safeParse({ ...validPaymentIntent, evidenceSource: 'PARTNER' }).success,
    ).toBe(false);
  });
});

describe('PaymentStatusV1 and status labels', () => {
  it('labels every domain state, with settlement as a separate dimension', () => {
    expect(statusLabelFor('created', 'not_applicable')).toBe('submitted');
    expect(statusLabelFor('transfer_committed', 'not_applicable')).toBe('processing');
    expect(statusLabelFor('unknown_reconciliation', 'not_applicable')).toBe(
      'unknown_needs_reconciliation',
    );
    expect(statusLabelFor('compensation_pending', 'not_applicable')).toBe(
      'unknown_needs_reconciliation',
    );
    expect(statusLabelFor('rejected', 'not_applicable')).toBe('rejected');
    expect(statusLabelFor('expired', 'not_applicable')).toBe('expired');
    expect(statusLabelFor('manual_resolution', 'not_applicable')).toBe('manual_resolution');
    expect(statusLabelFor('completed', 'settled')).toBe('settlement_simulated');
    expect(statusLabelFor('completed', 'pending')).toBe('recipient_credited_simulated');
    expect(statusLabelFor('completed', 'not_applicable')).toBe('recipient_credited_simulated');
  });

  it('parses a status with the explicit simulator note', () => {
    const status = {
      paymentIntentId: '11111111-2222-4333-8444-555555555555',
      state: 'completed',
      statusLabel: 'recipient_credited_simulated',
      settlementState: 'not_applicable',
      simulatorNote: 'simulated only: no bank debit, scheme transfer, or settlement occurred',
    };
    expect(PaymentStatusV1Schema.parse(status)).toEqual(status);
    const tampered = PaymentStatusV1Schema.safeParse({ ...status, simulatorNote: 'money sent!' });
    expect(tampered.success).toBe(false);
  });
});

describe('split contracts', () => {
  const validSplitRequest = {
    title: 'Team lunch',
    currency: 'SDG',
    totalMinor: '45000',
    roundingPolicy: 'explicit_minor_units',
    shares: [{ amountMinor: '15000' }, { amountMinor: '15000' }, { amountMinor: '15000' }],
  };

  it('accepts a valid split bill request', () => {
    expect(CreateSplitBillRequestV1Schema.parse(validSplitRequest)).toEqual(validSplitRequest);
  });

  it('rejects fewer than two shares and zero totals', () => {
    const one = CreateSplitBillRequestV1Schema.safeParse({
      ...validSplitRequest,
      shares: [{ amountMinor: '45000' }],
    });
    expect(one.success).toBe(false);
    const zero = CreateSplitBillRequestV1Schema.safeParse({
      ...validSplitRequest,
      totalMinor: '0',
    });
    expect(zero.success).toBe(false);
  });

  it('invite claims need a non-empty token', () => {
    const valid = { splitShareId: '33333333-4444-4555-8666-777777777777', inviteToken: 'tok-123' };
    expect(ClaimInviteRequestV1Schema.parse(valid)).toEqual(valid);
    const empty = ClaimInviteRequestV1Schema.safeParse({ ...valid, inviteToken: '' });
    expect(empty.success).toBe(false);
  });
});
