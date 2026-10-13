// Split-bill repository over the reviewed split migrations (0004 + 0005).
// Split coordination only: every share is a separate payment authorization (GUARDRAILS.md #4).
// Opening a bill validates the deferred >=2-shares-sum-to-total constraint; invite
// redemption goes through the atomic claim_split_share_invite function.

import { hexToBuffer, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

export interface SplitShareDraft {
  readonly amountMinor: bigint;
  readonly participantUserId?: string;
  /** Hex digest of the raw invite token; the preimage is never stored (migration 0005). */
  readonly inviteTokenDigest?: string;
  /** Required and in the future when the share carries an invite token. */
  readonly expiresAt?: string;
}

export interface CreateSplitBillInput {
  readonly splitBillId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly closesAt?: string;
  readonly shares: readonly SplitShareDraft[];
}

export interface StoredSplitBill {
  readonly splitBillId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly currency: string;
  readonly totalMinor: bigint;
  readonly splitState: string;
  readonly createdAt: Date;
  readonly closesAt?: Date;
}

export interface StoredSplitShare {
  readonly splitShareId: string;
  readonly splitBillId: string;
  readonly amountMinor: bigint;
  readonly shareState: string;
  readonly participantUserId?: string;
  readonly inviteConsumedAt?: Date;
  readonly expiresAt?: Date;
}

interface BillRow {
  split_bill_id: string;
  owner_user_id: string;
  title: string;
  currency: string;
  total_minor: bigint;
  split_state: string;
  closes_at: Date | null;
  created_at: Date;
}

interface ShareRow {
  split_share_id: string;
  split_bill_id: string;
  participant_user_id: string | null;
  amount_minor: bigint;
  share_state: string;
  expires_at: Date | null;
  invite_consumed_at: Date | null;
  created_at: Date;
}

function toBill(row: BillRow): StoredSplitBill {
  return {
    splitBillId: row.split_bill_id,
    ownerId: row.owner_user_id,
    title: row.title,
    currency: row.currency,
    totalMinor: row.total_minor,
    splitState: row.split_state,
    createdAt: row.created_at,
    ...(row.closes_at !== null ? { closesAt: row.closes_at } : {}),
  };
}

function toShare(row: ShareRow): StoredSplitShare {
  return {
    splitShareId: row.split_share_id,
    splitBillId: row.split_bill_id,
    amountMinor: row.amount_minor,
    shareState: row.share_state,
    ...(row.participant_user_id !== null ? { participantUserId: row.participant_user_id } : {}),
    ...(row.invite_consumed_at !== null ? { inviteConsumedAt: row.invite_consumed_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  };
}

export class PostgresSplitRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  /**
   * Creates the bill as a draft, inserts its shares, then opens the bill â all in one
   * transaction so the deferred balance constraint (>=2 shares summing exactly to
   * total_minor once open) is checked atomically at commit. That constraint is the
   * single source of truth: a malformed draft (too few or unbalanced shares) is
   * rejected by the database with a check-violation error.
   */
  async createBill(
    input: CreateSplitBillInput,
  ): Promise<{ bill: StoredSplitBill; shares: StoredSplitShare[] }> {
    return this.tx.run(async () => {
      const db = this.db;
      await db`
        INSERT INTO public.split_bills
          (split_bill_id, owner_user_id, title, currency, total_minor, split_state, closes_at)
        VALUES (${input.splitBillId}::uuid, ${input.ownerId}::uuid, ${input.title},
          ${input.currency}, ${input.totalMinor}, 'draft', ${input.closesAt ?? null}::timestamptz)`;
      const shares: StoredSplitShare[] = [];
      for (const share of input.shares) {
        if (share.inviteTokenDigest !== undefined && share.expiresAt === undefined) {
          throw new Error('a share with an invite token requires a future expiry');
        }
        const inserted = await db<ShareRow[]>`
          INSERT INTO public.split_shares
            (split_bill_id, participant_user_id, invite_token_sha256, amount_minor, expires_at)
          VALUES (${input.splitBillId}::uuid, ${share.participantUserId ?? null}::uuid,
            ${share.inviteTokenDigest !== undefined ? hexToBuffer(share.inviteTokenDigest) : null},
            ${share.amountMinor}, ${share.expiresAt ?? null}::timestamptz)
          RETURNING split_share_id, split_bill_id, participant_user_id, amount_minor,
                   share_state, expires_at, invite_consumed_at, created_at`;
        const row = inserted[0];
        if (!row) {
          throw new Error('createBill: share insert returned no row');
        }
        shares.push(toShare(row));
      }
      await db`
        UPDATE public.split_bills SET split_state = 'open'
        WHERE split_bill_id = ${input.splitBillId}::uuid`;
      const bill = await this.findBill(input.splitBillId);
      if (!bill) {
        throw new Error('createBill: bill disappeared after insert');
      }
      return { bill, shares };
    });
  }

  /**
   * One-time invite redemption through the atomic claim function: binds the actor,
   * marks consumption, serializes concurrent claims; the loser is rejected with 42501.
   * Claiming is NOT payment authorization (GUARDRAILS.md #4).
   */
  async claimInvite(input: {
    actorId: string;
    splitShareId: string;
    inviteTokenDigest: string;
  }): Promise<'claimed' | 'already_claimed'> {
    const rows = await this.db<{ result: string }[]>`
      SELECT app_private.claim_split_share_invite(
        ${input.actorId}::uuid, ${input.splitShareId}::uuid, ${hexToBuffer(input.inviteTokenDigest)}
      ) ->> 'result' AS result`;
    const result = rows[0]?.result;
    if (result !== 'claimed' && result !== 'already_claimed') {
      throw new Error('claim_split_share_invite returned an unexpected envelope');
    }
    return result;
  }

  async findBill(splitBillId: string): Promise<StoredSplitBill | null> {
    const rows = await this.db<BillRow[]>`
      SELECT split_bill_id, owner_user_id, title, currency, total_minor, split_state,
             closes_at, created_at
      FROM public.split_bills WHERE split_bill_id = ${splitBillId}::uuid`;
    const row = rows[0];
    return row ? toBill(row) : null;
  }

  async findShares(splitBillId: string): Promise<StoredSplitShare[]> {
    const rows = await this.db<ShareRow[]>`
      SELECT split_share_id, split_bill_id, participant_user_id, amount_minor, share_state,
             expires_at, invite_consumed_at, created_at
      FROM public.split_shares WHERE split_bill_id = ${splitBillId}::uuid ORDER BY created_at`;
    return rows.map(toShare);
  }

  async findShare(splitShareId: string): Promise<StoredSplitShare | null> {
    const rows = await this.db<ShareRow[]>`
      SELECT split_share_id, split_bill_id, participant_user_id, amount_minor, share_state,
             expires_at, invite_consumed_at, created_at
      FROM public.split_shares WHERE split_share_id = ${splitShareId}::uuid`;
    const row = rows[0];
    return row ? toShare(row) : null;
  }
}
