// Deterministic split allocation. Every share is a separate payment authorization and
// transfer (GUARDRAILS.md #4); these functions only compute exact amounts.

import { MoneyError } from './money.ts';

export type RoundingPolicy = 'explicit_minor_units' | 'remainder_to_first_share';

export type ShareAllocation = readonly bigint[];

/** Deterministic even allocation; any remainder goes to the first share. */
export function allocateEvenly(
  totalMinor: bigint,
  shareCount: number,
  policy: RoundingPolicy,
): ShareAllocation {
  if (totalMinor <= 0n) {
    throw new MoneyError('non_positive', 'total must be positive');
  }
  if (!Number.isInteger(shareCount) || shareCount < 2) {
    throw new MoneyError('invalid_amount', 'an allocation needs at least 2 shares');
  }
  if (policy !== 'remainder_to_first_share') {
    throw new MoneyError(
      'invalid_amount',
      'derived allocations must use remainder_to_first_share; explicit amounts must be checked with assertAllocationExact',
    );
  }
  const count = BigInt(shareCount);
  const base = totalMinor / count;
  const remainder = totalMinor % count;
  const shares: bigint[] = new Array<bigint>(shareCount).fill(base);
  shares[0] = base + remainder;
  return shares;
}

export function sumShares(shares: ShareAllocation): bigint {
  return shares.reduce((acc, share) => acc + share, 0n);
}

/** Verifies a caller-supplied allocation is exact: positive shares summing to the total. */
export function assertAllocationExact(totalMinor: bigint, shares: ShareAllocation): void {
  if (totalMinor <= 0n) {
    throw new MoneyError('non_positive', 'total must be positive');
  }
  if (shares.length < 2) {
    throw new MoneyError('invalid_amount', 'an allocation needs at least 2 shares');
  }
  for (const share of shares) {
    if (share <= 0n) {
      throw new MoneyError('non_positive', 'every share must be positive');
    }
  }
  if (sumShares(shares) !== totalMinor) {
    throw new MoneyError('invalid_amount', 'shares do not sum exactly to the total');
  }
}
