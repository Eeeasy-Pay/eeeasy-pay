// Shared fixtures for integration tests (*.int.test.ts). All seeding runs as the
// disposable test database's admin user against synthetic identities only (GUARDRAILS.md #5).

import type { QuoteBindingTerms } from '@eeeasy-pay/pal';
import { quoteBindingSha256, sha256Hex } from '@eeeasy-pay/pal';
import type { Db } from './db.ts';
import { hexToBuffer } from './hex.ts';
import type { PersistenceStores } from './stores.ts';

/** ISO 4217 test-only currency; no market or currency claim (B-08). */
export const CURRENCY = 'XTS';

/** Deterministic, valid-format uuid from a stable name (synthetic identities only). */
export function deterministicId(kind: string, ref: string): string {
  const h = sha256Hex(kind + ':' + ref);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function seedUser(db: Db, userId: string): Promise<void> {
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
    userId,
    userId + '@simulator.invalid',
  ]);
}

export async function seedActiveBankLink(db: Db, userId: string, ref: string): Promise<string> {
  const bankLinkId = deterministicId('bank-link', ref);
  const consent = await db.query<{ consent_event_id: string }>(
    `INSERT INTO public.consent_events
         (user_id, consent_key, document_version, action, channel)
       VALUES ($1, 'bank_link_consent', 'sim-v1', 'granted', 'mobile')
       RETURNING consent_event_id`,
    [userId],
  );
  const consentEventId = consent.rows[0]?.consent_event_id;
  if (!consentEventId) {
    throw new Error('seeding consent_events failed');
  }
  await db.query(
    `INSERT INTO public.bank_links
         (bank_link_id, user_id, provider_key, partner_link_ref, currency, link_state,
          consent_event_id, ownership_evidence_ref, verified_at)
       VALUES ($1, $2, 'sim-dfsp', $3, $4, 'active', $5, 'sim-ownership-evidence', now())`,
    [bankLinkId, userId, 'sim-partner-link-' + ref, CURRENCY, consentEventId],
  );
  return bankLinkId;
}

export async function seedActiveAlias(db: Db, ref: string): Promise<string> {
  const aliasId = deterministicId('alias', ref);
  await db.query(
    `INSERT INTO public.alias_associations
         (alias_association_id, alias_type, alias_token, token_key_version, participant_ref,
          external_party_ref, projection_state, source_system, evidence_ref, effective_at)
       VALUES ($1, 'phone', $2, 1, $3, $4, 'active', 'simulator', 'sim-alias-evidence', now())`,
    [
      aliasId,
      hexToBuffer(sha256Hex('alias-token:' + ref)),
      'sim-participant-' + ref,
      'sim-party-' + ref,
    ],
  );
  return aliasId;
}

export interface SeededQuotedIntent {
  readonly userId: string;
  readonly paymentIntentId: string;
  readonly quoteId: string;
  readonly bindingDigest: string;
  readonly bankLinkId: string;
  readonly aliasId: string;
  readonly amountMinor: bigint;
}

export interface QuoteIntentSeed {
  readonly userId: string;
  readonly ref: string;
  readonly amountMinor?: bigint;
  /** Overrides the default 60s-from-now expiry (e.g. an already-expired quote). */
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}

/**
 * Seeds a fully quoted, confirmable payment intent through the repositories under test:
 * active route (consented bank link + active alias), intent creation, quote insertion with
 * a pal-computed binding digest, and quote attachment.
 */
export async function seedQuotedIntent(
  db: Db,
  stores: PersistenceStores,
  seed: QuoteIntentSeed,
): Promise<SeededQuotedIntent> {
  const amountMinor = seed.amountMinor ?? 1000n;
  const issuedAt = seed.issuedAt ?? new Date(Date.now() - 1_000).toISOString();
  const expiresAt = seed.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  const bankLinkId = await seedActiveBankLink(db, seed.userId, seed.ref);
  const aliasId = await seedActiveAlias(db, seed.ref);
  const paymentIntentId = deterministicId('intent', seed.ref);
  const quoteId = deterministicId('quote', seed.ref);
  const terms: QuoteBindingTerms = {
    quoteId,
    paymentIntentId,
    providerKey: 'sim-dfsp',
    partnerQuoteRef: 'SQ-' + seed.ref,
    apiProfile: 'SIMULATOR',
    currency: CURRENCY,
    requestedAmountMinor: String(amountMinor),
    quotedFeeMinor: '1',
    payerDebitMinor: String(amountMinor + 1n),
    recipientAmountMinor: String(amountMinor),
    feeRuleVersion: 'simulator-flat-1',
    issuedAt,
    expiresAt,
  };
  await stores.intents.create({
    paymentIntentId,
    actorId: seed.userId,
    sourceBankLinkId: bankLinkId,
    recipientAliasId: aliasId,
    currency: CURRENCY,
    requestedAmountMinor: amountMinor,
  });
  await stores.quotes.insertQuote({
    quoteId,
    paymentIntentId,
    providerKey: terms.providerKey,
    partnerQuoteRef: terms.partnerQuoteRef,
    apiProfile: terms.apiProfile,
    currency: CURRENCY,
    requestedAmountMinor: amountMinor,
    quotedFeeMinor: 1n,
    payerDebitMinor: amountMinor + 1n,
    recipientAmountMinor: amountMinor,
    feeRuleVersion: terms.feeRuleVersion,
    requestFingerprintDigest: sha256Hex('quote-request:' + seed.ref),
    bindingDigest: quoteBindingSha256(terms),
    issuedAt,
    expiresAt,
  });
  await stores.intents.attachQuote(paymentIntentId, quoteId);
  return {
    userId: seed.userId,
    paymentIntentId,
    quoteId,
    bindingDigest: quoteBindingSha256(terms),
    bankLinkId,
    aliasId,
    amountMinor,
  };
}

export interface SeededSplitBill {
  readonly splitBillId: string;
  readonly shares: ReadonlyArray<{
    readonly splitShareId: string;
    readonly participantUserId: string | null;
    readonly inviteTokenDigest: string;
  }>;
}

/**
 * Seeds an OPEN split bill with two invite-token shares summing exactly to the total
 * (the open-bill balance trigger requires this). Invite tokens require a future share
 * expiry (migration 202610060005).
 */
export async function seedOpenSplitBill(
  db: Db,
  ref: string,
  ownerUserId: string,
): Promise<SeededSplitBill> {
  const splitBillId = deterministicId('split-bill', ref);
  await db.query(
    `INSERT INTO public.split_bills (split_bill_id, owner_user_id, title, currency, total_minor)
       VALUES ($1, $2, $3, $4, 1000)`,
    [splitBillId, ownerUserId, 'sim split ' + ref, CURRENCY],
  );
  const shares: Array<{
    splitShareId: string;
    participantUserId: string | null;
    inviteTokenDigest: string;
  }> = [];
  for (const part of ['a', 'b']) {
    const splitShareId = deterministicId('split-share', ref + '-' + part);
    const inviteTokenDigest = sha256Hex('invite-token:' + ref + ':' + part);
    await db.query(
      `INSERT INTO public.split_shares
           (split_share_id, split_bill_id, invite_token_sha256, amount_minor, expires_at)
         VALUES ($1, $2, $3, 500, now() + interval '1 hour')`,
      [splitShareId, splitBillId, hexToBuffer(inviteTokenDigest)],
    );
    shares.push({ splitShareId, participantUserId: null, inviteTokenDigest });
  }
  await db.query("UPDATE public.split_bills SET split_state = 'open' WHERE split_bill_id = $1", [
    splitBillId,
  ]);
  return { splitBillId, shares };
}
