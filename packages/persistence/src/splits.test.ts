// TICKET-004 acceptance: split-bill persistence. Opening validates the deferred
// >=2-shares-sum-to-total constraint; invite redemption is one-time, atomic and
// actor-bound (migrations 0004 + 0005). Claiming is NOT payment authorization.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  createHarness,
  databaseUrl,
  expectPgError,
  seedIdentity,
  testUuid,
  truncateAll,
  type Harness,
  type Seed,
  type SeedUser,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('split persistence', () => {
  const h: Harness = createHarness(databaseUrl);
  let seed: Seed;

  beforeEach(async () => {
    await truncateAll(h);
    seed = await seedIdentity(h);
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  function owner(): SeedUser {
    const user = seed.users[0];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user;
  }

  function claimer(): SeedUser {
    const user = seed.users[1];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user;
  }

  function stranger(): SeedUser {
    const user = seed.users[2];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user;
  }

  function inviteShares(tokenKeys: readonly string[], amounts: readonly bigint[], expiresAt: string) {
    return tokenKeys.map((tokenKey, index) => ({
      amountMinor: amounts[index] ?? 1n,
      inviteTokenDigest: sha256Hex('invite:' + tokenKey),
      expiresAt,
    }));
  }

  it('creates and opens a balanced split bill with invite shares', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const splitBillId = testUuid();
    const { bill, shares } = await h.splits.createBill({
      splitBillId,
      ownerId: owner().userId,
      title: 'team dinner',
      currency: 'XTS',
      totalMinor: 3000n,
      shares: inviteShares(['a', 'b'], [1000n, 2000n], expiresAt),
    });
    expect(bill).toMatchObject({ splitBillId, splitState: 'open', totalMinor: 3000n });
    expect(shares).toHaveLength(2);
    const stored = await h.splits.findShares(splitBillId);
    expect(stored.map((s) => s.amountMinor).sort()).toEqual([1000n, 2000n]);
    expect(stored.every((s) => s.shareState === 'unpaid')).toBe(true);
  });

  it('refuses to open a split bill whose shares do not sum to the total', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await expectPgError(
      () =>
        h.splits.createBill({
          splitBillId: testUuid(),
          ownerId: owner().userId,
          title: 'unbalanced dinner',
          currency: 'XTS',
          totalMinor: 3000n,
          shares: inviteShares(['a', 'b'], [1000n, 1500n], expiresAt),
        }),
      '23514',
    );
  });

  it('refuses to open a split bill with fewer than two shares', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await expectPgError(
      () =>
        h.splits.createBill({
          splitBillId: testUuid(),
          ownerId: owner().userId,
          title: 'lonely dinner',
          currency: 'XTS',
          totalMinor: 1000n,
          shares: inviteShares(['a'], [1000n], expiresAt),
        }),
      '23514',
    );
  });

  it('claims an invite exactly once and binds it to the claiming actor', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const { shares } = await h.splits.createBill({
      splitBillId: testUuid(),
      ownerId: owner().userId,
      title: 'shared cab',
      currency: 'XTS',
      totalMinor: 2000n,
      shares: inviteShares(['a', 'b'], [1000n, 1000n], expiresAt),
    });
    const shareId = shares[0]?.splitShareId;
    if (!shareId) {
      throw new Error('share missing');
    }
    const digest = sha256Hex('invite:a');
    // Wrong token is rejected.
    await expectPgError(
      () =>
        h.splits.claimInvite({
          actorId: claimer().userId,
          splitShareId: shareId,
          inviteTokenDigest: sha256Hex('invite:wrong'),
        }),
      '42501',
    );
    // First claim binds the actor.
    expect(
      await h.splits.claimInvite({
        actorId: claimer().userId,
        splitShareId: shareId,
        inviteTokenDigest: digest,
      }),
    ).toBe('claimed');
    const share = await h.splits.findShare(shareId);
    expect(share?.participantUserId).toBe(claimer().userId);
    expect(share?.inviteConsumedAt).toBeDefined();
    // Re-claiming by the same actor is an explicit no-op.
    expect(
      await h.splits.claimInvite({
        actorId: claimer().userId,
        splitShareId: shareId,
        inviteTokenDigest: digest,
      }),
    ).toBe('already_claimed');
    // Another actor cannot reuse the consumed invite.
    await expectPgError(
      () =>
        h.splits.claimInvite({
          actorId: stranger().userId,
          splitShareId: shareId,
          inviteTokenDigest: digest,
        }),
      '42501',
    );
    // The consumed binding stays.
    const after = await h.splits.findShare(shareId);
    expect(after?.participantUserId).toBe(claimer().userId);
  });

  it('refuses to claim an expired invite', async () => {
    const nearExpiry = new Date(Date.now() + 150).toISOString();
    const { shares } = await h.splits.createBill({
      splitBillId: testUuid(),
      ownerId: owner().userId,
      title: 'flash sale',
      currency: 'XTS',
      totalMinor: 2000n,
      shares: inviteShares(['a', 'b'], [1000n, 1000n], nearExpiry),
    });
    const shareId = shares[0]?.splitShareId;
    if (!shareId) {
      throw new Error('share missing');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expectPgError(
      () =>
        h.splits.claimInvite({
          actorId: claimer().userId,
          splitShareId: shareId,
          inviteTokenDigest: sha256Hex('invite:a'),
        }),
      '42501',
    );
  });
});
