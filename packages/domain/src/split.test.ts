import { describe, expect, it } from 'vitest';
import { MoneyError } from './money.ts';
import { allocateEvenly, assertAllocationExact, sumShares } from './split.ts';

describe('allocateEvenly', () => {
  it('distributes exact amounts with the remainder on the first share', () => {
    expect(allocateEvenly(1000n, 3, 'remainder_to_first_share')).toEqual([334n, 333n, 333n]);
    expect(allocateEvenly(900n, 3, 'remainder_to_first_share')).toEqual([300n, 300n, 300n]);
  });
  it('always sums exactly to the total', () => {
    for (const total of [1n, 7n, 999n, 123457n]) {
      for (const shares of [2, 3, 7, 11]) {
        const alloc = allocateEvenly(total, shares, 'remainder_to_first_share');
        expect(sumShares(alloc)).toBe(total);
        expect(alloc.length).toBe(shares);
      }
    }
  });
  it('rejects invalid inputs and wrong policy', () => {
    expect(() => allocateEvenly(0n, 3, 'remainder_to_first_share')).toThrow(MoneyError);
    expect(() => allocateEvenly(10n, 1, 'remainder_to_first_share')).toThrow(MoneyError);
    expect(() => allocateEvenly(10n, 3, 'explicit_minor_units' as const)).toThrow(MoneyError);
  });
});

describe('assertAllocationExact', () => {
  it('accepts exact allocations', () => {
    expect(() => assertAllocationExact(100n, [60n, 40n])).not.toThrow();
  });
  it('rejects under/over sums, non-positive shares, and single shares', () => {
    expect(() => assertAllocationExact(100n, [60n, 39n])).toThrow(MoneyError);
    expect(() => assertAllocationExact(100n, [60n, 41n])).toThrow(MoneyError);
    expect(() => assertAllocationExact(100n, [100n, 0n])).toThrow(MoneyError);
    expect(() => assertAllocationExact(100n, [100n])).toThrow(MoneyError);
  });
});
