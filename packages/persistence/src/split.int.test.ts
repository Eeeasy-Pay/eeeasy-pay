import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Db } from './db.ts';
import { InviteUnavailableError } from '@eeeasy-pay/ports';
import { sha256Hex } from '@eeeasy-pay/pal';
import { deterministicId, seedOpenSplitBill, seedUser } from './int-helpers.ts';
import { createPersistenceStores } from './stores.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require a disposable Postgres database ' +
      'with ci/db/prepare.sql and all supabase/migrations applied (see README.md).',
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const stores = createPersistenceStores(pool);
const db: Db = stores.db;

const OWNER = deterministicId('user', 'split-owner');
const USER_A = deterministicId('user', 'split-a');
const USER_B = deterministicId('user', 'split-b');
const USER_C = deterministicId('user', 'split-c');

beforeAll(async () => {
  await seedUser(db, OWNER);
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await seedUser(db, USER_C);
});

afterAll(async () => {
  await pool.end();
});

describe('split invite claim (atomic redemption)', () => {
  it('claims once, reports already_claimed for the same actor, rejects everyone else', async () => {
    const bill = await seedOpenSplitBill(db, 'split-main', OWNER);
    const share = bill.shares[0];
    expect(share).toBeDefined();
    if (!share) {
      throw new Error('expected a seeded share');
    }

    await expect(
      stores.split.claimInvite({
        actorId: USER_A,
        splitShareId: share.splitShareId,
        inviteTokenDigest: share.inviteTokenDigest,
      }),
    ).resolves.toBe('claimed');

    await expect(
      stores.split.claimInvite({
        actorId: USER_A,
        splitShareId: share.splitShareId,
        inviteTokenDigest: share.inviteTokenDigest,
      }),
    ).resolves.toBe('already_claimed');

    // A different actor must never take over a consumed invite.
    await expect(
      stores.split.claimInvite({
        actorId: USER_B,
        splitShareId: share.splitShareId,
        inviteTokenDigest: share.inviteTokenDigest,
      }),
    ).rejects.toBeInstanceOf(InviteUnavailableError);

    // The participant binding is recorded exactly once.
    const row = await db.query<{ participant_user_id: string | null; consumed: boolean }>(
      `SELECT participant_user_id, invite_consumed_at IS NOT NULL AS consumed
         FROM public.split_shares WHERE split_share_id = $1`,
      [share.splitShareId],
    );
    expect(row.rows[0]?.participant_user_id).toBe(USER_A);
    expect(row.rows[0]?.consumed).toBe(true);
  });

  it('rejects a wrong token digest without revealing anything', async () => {
    const bill = await seedOpenSplitBill(db, 'split-token', OWNER);
    const share = bill.shares[1];
    expect(share).toBeDefined();
    if (!share) {
      throw new Error('expected a seeded share');
    }
    await expect(
      stores.split.claimInvite({
        actorId: USER_A,
        splitShareId: share.splitShareId,
        inviteTokenDigest: sha256Hex('wrong-token'),
      }),
    ).rejects.toBeInstanceOf(InviteUnavailableError);
    const row = await db.query<{ participant_user_id: string | null }>(
      'SELECT participant_user_id FROM public.split_shares WHERE split_share_id = $1',
      [share.splitShareId],
    );
    expect(row.rows[0]?.participant_user_id).toBeNull();
  });

  it('lets exactly one of two racing actors win the same invite', async () => {
    const bill = await seedOpenSplitBill(db, 'split-race', OWNER);
    const share = bill.shares[0];
    expect(share).toBeDefined();
    if (!share) {
      throw new Error('expected a seeded share');
    }
    const outcomes = await Promise.allSettled([
      stores.split.claimInvite({
        actorId: USER_B,
        splitShareId: share.splitShareId,
        inviteTokenDigest: share.inviteTokenDigest,
      }),
      stores.split.claimInvite({
        actorId: USER_C,
        splitShareId: share.splitShareId,
        inviteTokenDigest: share.inviteTokenDigest,
      }),
    ]);
    const claimed = outcomes.filter((o) => o.status === 'fulfilled' && o.value === 'claimed');
    const rejected = outcomes.filter(
      (o) => o.status === 'rejected' && o.reason instanceof InviteUnavailableError,
    );
    expect(claimed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const row = await db.query<{ participant_user_id: string | null }>(
      'SELECT participant_user_id FROM public.split_shares WHERE split_share_id = $1',
      [share.splitShareId],
    );
    const winner = row.rows[0]?.participant_user_id ?? null;
    expect([USER_B, USER_C]).toContain(winner);
  });
});
