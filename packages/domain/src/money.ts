// Exact integer minor-unit money. NEVER binary floating point (GUARDRAILS.md #4).
// Currency codes are placeholders until a partner profile fixes the currency set (B-08).

export type CurrencyCode = string;

/** Half the signed 64-bit range: keeps intermediate sums inside safe bounds. */
export const MAX_ABS_MINOR: bigint = (2n ** 63n - 1n) / 2n;

export type MoneyErrorCode =
  | 'invalid_amount'
  | 'non_positive'
  | 'negative'
  | 'currency_mismatch'
  | 'overflow'
  | 'fee_out_of_range';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface MinorAmount {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

function assertBounds(minor: bigint): void {
  if (minor > MAX_ABS_MINOR) {
    throw new MoneyError('overflow', 'amount exceeds the minor-unit safety bound');
  }
}

/** Parses a plain digit string as minor units. Rejects signs, decimals, and junk. */
export function parseMinorUnits(input: string): bigint {
  if (!/^[0-9]+$/.test(input)) {
    throw new MoneyError('invalid_amount', 'minor-unit amounts must be a plain digit string');
  }
  const value = BigInt(input);
  assertBounds(value);
  return value;
}

/** Positive-only money (principal amounts, debits). */
export function money(currency: CurrencyCode, minor: bigint): MinorAmount {
  if (minor <= 0n) {
    throw new MoneyError('non_positive', 'amount must be positive');
  }
  assertBounds(minor);
  return { currency, minor };
}

/** Non-negative money (fees may be zero). */
export function nonNegative(currency: CurrencyCode, minor: bigint): MinorAmount {
  if (minor < 0n) {
    throw new MoneyError('negative', 'amount must not be negative');
  }
  assertBounds(minor);
  return { currency, minor };
}

function assertSameCurrency(a: MinorAmount, b: MinorAmount): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      'currency_mismatch',
      'cannot combine currencies ' + a.currency + ' and ' + b.currency,
    );
  }
}

export function add(a: MinorAmount, b: MinorAmount): MinorAmount {
  assertSameCurrency(a, b);
  const sum = a.minor + b.minor;
  assertBounds(sum);
  return { currency: a.currency, minor: sum };
}

export function subtract(a: MinorAmount, b: MinorAmount): MinorAmount {
  assertSameCurrency(a, b);
  const diff = a.minor - b.minor;
  assertBounds(diff);
  return { currency: a.currency, minor: diff };
}

export interface QuoteTotals {
  readonly currency: CurrencyCode;
  readonly requestedAmountMinor: bigint;
  readonly quotedFeeMinor: bigint;
  readonly payerDebitMinor: bigint;
  /**
   * Simulator placeholder: the recipient receives the requested amount. FX / cross-border is
   * out of scope, so no conversion is applied or invented here.
   */
  readonly recipientAmountMinor: bigint;
}

/**
 * Deterministic quote totals: payerDebit = requested + fee, mirroring the DB CHECKs on
 * payment_intents and payment_quotes. The fee bound is a SANITY GUARD against garbage
 * simulator/provider input, NOT a fee schedule; real fees come from the partner profile.
 */
export function quoteTotals(
  currency: CurrencyCode,
  requestedAmountMinor: bigint,
  quotedFeeMinor: bigint,
): QuoteTotals {
  const requested = money(currency, requestedAmountMinor);
  const fee = nonNegative(currency, quotedFeeMinor);
  if (fee.minor > requested.minor * 1000n) {
    throw new MoneyError('fee_out_of_range', 'fee exceeds the sanity bound of 1000x the principal');
  }
  const payerDebit = add(requested, fee);
  return {
    currency,
    requestedAmountMinor: requested.minor,
    quotedFeeMinor: fee.minor,
    payerDebitMinor: payerDebit.minor,
    recipientAmountMinor: requested.minor,
  };
}
