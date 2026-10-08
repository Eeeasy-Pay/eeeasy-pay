import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MAX_ABS_MINOR,
  add,
  money,
  nonNegative,
  parseMinorUnits,
  quoteTotals,
  subtract,
} from './money.ts';

describe('parseMinorUnits', () => {
  it('accepts plain digit strings', () => {
    expect(parseMinorUnits('0')).toBe(0n);
    expect(parseMinorUnits('1250')).toBe(1250n);
  });
  it('rejects signs, decimals, and junk', () => {
    for (const bad of ['-1', '12.5', '1e3', '', 'abc', '1 2']) {
      expect(() => parseMinorUnits(bad)).toThrow(MoneyError);
    }
  });
  it('rejects amounts above the safety bound', () => {
    expect(() => parseMinorUnits((MAX_ABS_MINOR + 1n).toString())).toThrow(MoneyError);
  });
});

describe('money and nonNegative', () => {
  it('money is positive-only', () => {
    expect(money('XTS', 5n).minor).toBe(5n);
    expect(() => money('XTS', 0n)).toThrow(MoneyError);
    expect(() => money('XTS', -5n)).toThrow(MoneyError);
  });
  it('nonNegative allows zero (fees) but not negatives', () => {
    expect(nonNegative('XTS', 0n).minor).toBe(0n);
    expect(() => nonNegative('XTS', -1n)).toThrow(MoneyError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within the same currency', () => {
    const a = money('XTS', 100n);
    const b = money('XTS', 23n);
    expect(add(a, b).minor).toBe(123n);
    expect(subtract(a, b).minor).toBe(77n);
  });
  it('rejects mixed currencies', () => {
    expect(() => add(money('XTS', 1n), money('USD', 1n))).toThrow(MoneyError);
    expect(() => subtract(money('XTS', 1n), money('USD', 1n))).toThrow(MoneyError);
  });
  it('rejects overflow of the safety bound', () => {
    expect(() => add(money('XTS', MAX_ABS_MINOR), money('XTS', 1n))).toThrow(MoneyError);
  });
});

describe('quoteTotals', () => {
  it('computes payerDebit = requested + fee exactly', () => {
    const t = quoteTotals('XTS', 1000n, 25n);
    expect(t.payerDebitMinor).toBe(1025n);
    expect(t.recipientAmountMinor).toBe(1000n);
    expect(t.quotedFeeMinor).toBe(25n);
  });
  it('allows zero fees', () => {
    expect(quoteTotals('XTS', 1000n, 0n).payerDebitMinor).toBe(1000n);
  });
  it('rejects absurd fees (sanity guard, not a schedule)', () => {
    expect(() => quoteTotals('XTS', 1000n, 1000n * 1000n + 1n)).toThrow(MoneyError);
  });
  it('rejects non-positive principals and negative fees', () => {
    expect(() => quoteTotals('XTS', 0n, 0n)).toThrow(MoneyError);
    expect(() => quoteTotals('XTS', 10n, -1n)).toThrow(MoneyError);
  });
});
