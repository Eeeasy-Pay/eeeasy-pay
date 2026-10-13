import type { SplitInviteClaimPort } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { mapDbErrorAsync } from './errors.ts';
import { hexToBuffer } from './hex.ts';

/**
 * Atomic invite redemption through app_private.claim_split_share_invite: the share and
 * its bill are locked FOR UPDATE, the token digest is compared in the database, and the
 * consumption is a single guarded UPDATE. Claiming an invite is NOT a payment
 * authorization (GUARDRAILS.md #4).
 */
export class PostgresSplitInviteClaim implements SplitInviteClaimPort {
  constructor(private readonly db: Db) {}

  async claimInvite(input: {
    actorId: string;
    splitShareId: string;
    inviteTokenDigest: string;
  }): Promise<'claimed' | 'already_claimed'> {
    return mapDbErrorAsync(async () => {
      const result = await this.db.query<{ result: Record<string, unknown> }>(
        'SELECT app_private.claim_split_share_invite($1, $2, $3) AS result',
        [input.actorId, input.splitShareId, hexToBuffer(input.inviteTokenDigest)],
      );
      const value = result.rows[0]?.result;
      if (typeof value !== 'object' || value === null) {
        throw new Error('claim_split_share_invite did not return a result object');
      }
      const outcome = value['result'];
      if (outcome === 'claimed' || outcome === 'already_claimed') {
        return outcome;
      }
      throw new Error('claim_split_share_invite returned an unknown result: ' + String(outcome));
    });
  }
}
