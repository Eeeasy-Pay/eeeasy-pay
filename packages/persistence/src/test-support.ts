// Shared harness for the persistence integration tests (TICKET-004).
// The suites skip entirely when DATABASE_URL is absent, so the no-Postgres CI jobs stay
// green; the dedicated persistence-tests CI job provides Postgres and runs them.

import { PostgresIdempotencyRepository } from './idempotency.ts';
import { PostgresInboxRepository } from './inbox.ts';
import { PostgresPaymentIntentRepository } from './intents.ts';
import { PostgresJournalRepository } from './journal.ts';
import { PostgresOutboxRepository } from './outbox.ts';
import { PostgresSplitRepository } from './splits.ts';
import { createPersistenceSql, hexToBuffer, type Sql } from './client.ts';
import { PostgresTransactions } from './transactions.ts';
import { sha256Hex } from '@eeeasy-pay/pal';

export const databaseUrl = process.env.DATABASE_URL ?? '';

export interface Harness {
  readonly sql: Sql;
  readonly transactions: PostgresTransactions;
  readonly intents: PostgresPaymentIntentRepository;
  readonly idempotency: PostgresIdempotencyRepository;
  readonly outbox: PostgresOutboxRepository;
  readonly inbox: PostgresInboxRepository;
  readonly splits: PostgresSplitRepository;
  readonly journal: PostgresJournalRepository;
}

export function createHarness(url: string): Harness {
  const sql = createPersistenceSql(url);
  const transactions = new PostgresTransactions(sql);
  return {
    sql,
    transactions,
    intents: new PostgresPaymentIntentRepository(transactions),
    idempotency: new PostgresIdempotencyRepository(transactions),
    outbox: new PostgresOutboxRepository(transactions),
    inbox: new PostgresInboxRepository(transactions),
    splits: new PostgresSplitRepository(transactions),
    journal: new PostgresJournalRepository(transactions),
  };
}

let uuidCounter = 0;

/** Deterministic distinct v4-shaped uuids so tests can trace their own rows. */
export function testUuid(): string {
  uuidCounter += 1;
  return '00000000-0000-4000-8000-' + String(uuidCounter).padStart(12, '0');
}

export interface SeedUser {
  readonly userId: string;
  readonly consentEventId: string;
  readonly bankLinkId: string;
  readonly aliasId: string;
}

export interface Seed {
  readonly users: readonly SeedUser[];
}

const TEST_CURRENCY = 'XTS';

/** Superuser fixture seeding: one active bank link + verified alias per user. */
export async function seedIdentity(h: Harness, userCount = 3): Promise<Seed> {
  const users: SeedUser[] = [];
  for (let i = 0; i < userCount; i += 1) {
    const userId = testUuid();
    const consentEventId = testUuid();
    const bankLinkId = testUuid();
    const phoneId = testUuid();
    const aliasId = testUuid();
    const db = h.sql;
    await db`
      INSERT INTO auth.users (id) VALUES (${userId}::uuid)`;
    await db`
      INSERT INTO public.consent_events
        (consent_event_id, user_id, consent_key, document_version, action, channel)
      VALUES (${consentEventId}::uuid, ${userId}::uuid, 'payments', 'test-v1',
        'granted'::public.consent_action, 'mobile')`;
    await db`
      INSERT INTO public.bank_links
        (bank_link_id, user_id, provider_key, partner_link_ref, currency, link_state,
         consent_event_id, ownership_evidence_ref, verified_at)
      VALUES (${bankLinkId}::uuid, ${userId}::uuid, 'sim-dfsp', ${'link-' + bankLinkId},
        ${TEST_CURRENCY}, 'active'::public.bank_link_state, ${consentEventId}::uuid,
        ${'ownership-' + userId}, now())`;
    await db`
      INSERT INTO public.verified_phones
        (verified_phone_id, user_id, phone_token, token_key_version, verification_state,
         verification_method, verified_at)
      VALUES (${phoneId}::uuid, ${userId}::uuid, ${hexToBuffer(sha256Hex('phone:' + userId))},
        1, 'verified'::public.phone_verification_state, 'partner_assertion', now())`;
    await db`
      INSERT INTO public.alias_associations
        (alias_association_id, verified_phone_id, alias_type, alias_token, token_key_version,
         participant_ref, external_party_ref, projection_state, source_system, evidence_ref)
      VALUES (${aliasId}::uuid, ${phoneId}::uuid, 'phone', ${hexToBuffer(sha256Hex('alias:' + userId))},
        1, ${'participant-' + userId}, ${'party-' + userId},
        'active'::public.alias_projection_state, 'sim', ${'evidence-' + userId})`;
    users.push({ userId, consentEventId, bankLinkId, aliasId });
  }
  return { users };
}

/** Wipes ALL rows between tests. Disposable CI database only (GUARDRAILS.md). */
export async function truncateAll(h: Harness): Promise<void> {
  await h.sql.unsafe(
    'TRUNCATE auth.users, public.profiles, public.consent_events, public.verified_phones, ' +
      'public.alias_associations, public.bank_links, public.payment_intents, public.payment_quotes, ' +
      'public.idempotency_records, public.payment_events, public.journal_transactions, ' +
      'public.journal_entries, public.outbox_messages, public.inbox_events, public.split_bills, ' +
      'public.split_shares',
  );
}

/** Asserts the call rejects with the given Postgres error code (throws otherwise). */
export async function expectPgError(call: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  let failed = false;
  try {
    await call();
  } catch (err) {
    failed = true;
    caught = err;
  }
  if (!failed) {
    throw new Error('expected a Postgres error with code ' + code + ' but the call succeeded');
  }
  const actual =
    typeof caught === 'object' && caught !== null && 'code' in caught
      ? String((caught as { code?: unknown }).code)
      : undefined;
  if (actual !== code) {
    throw caught;
  }
}

export async function countRows(h: Harness, table: string, where?: string): Promise<number> {
  const rows = (await h.sql.unsafe(
    'SELECT count(*)::int AS n FROM public.' + table + (where === undefined ? '' : ' WHERE ' + where),
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export interface QuotedIntent {
  readonly intentId: string;
  readonly quoteId: string;
  readonly bindingDigest: string;
  readonly requestDigest: string;
}

/** Creates a valid, freshly quoted intent for the given seeded user. */
export async function seedQuotedIntent(h: Harness, user: SeedUser, options?: {
  expiresAt?: string;
  issuedAt?: string;
}): Promise<QuotedIntent> {
  const intentId = testUuid();
  const quoteId = testUuid();
  const now = Date.now();
  const issuedAt = options?.issuedAt ?? new Date(now - 60_000).toISOString();
  const expiresAt = options?.expiresAt ?? new Date(now + 60_000).toISOString();
  const bindingDigest = sha256Hex('binding:' + quoteId);
  await h.intents.createIntentWithQuote({
    paymentIntentId: intentId,
    actorId: user.userId,
    sourceBankLinkId: user.bankLinkId,
    recipientAliasId: user.aliasId,
    currency: TEST_CURRENCY,
    requestedAmountMinor: 1000n,
    quote: {
      quoteId,
      providerKey: 'sim-dfsp',
      partnerQuoteRef: 'pqr-' + quoteId,
      apiProfile: 'SIMULATOR',
      quotedFeeMinor: 1n,
      feeRuleVersion: 'flat-1',
      issuedAt,
      expiresAt,
      bindingDigest,
      requestDigest: sha256Hex('quote-request:' + quoteId),
    },
    correlationId: testUuid(),
  });
  return {
    intentId,
    quoteId,
    bindingDigest,
    requestDigest: sha256Hex('confirm:' + intentId),
  };
}

export { TEST_CURRENCY };
