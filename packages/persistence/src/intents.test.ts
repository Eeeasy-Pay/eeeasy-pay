// TICKET-004 acceptance: durable payment-intent persistence. Creates intents with bound
// quotes, and proves the confirm command produces exactly one durable outbox command
// under concurrency, with idempotent replay and no duplicate effects (ADR-006).

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  countRows,
  createHarness,
  databaseUrl,
  expectPgError,
  seedIdentity,
  seedQuotedIntent,
  TEST_CURRENCY,
  testUuid,
  truncateAll,
  type Harness,
  type Seed,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('payment intent persistence', () => {
  const h: Harness = createHarness(databaseUrl);
  let seed: Seed;

  beforeEach(async () => {
    await truncateAll(h);
    seed = await seedIdentity(h);
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  it('creates an intent with a bound quote and finds it for the owning actor only', async () => {
    const [alice, bob] = seed.users;
    if (!alice || !bob) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const record = await h.intents.findOwnedById(quoted.intentId, alice.userId);
    expect(record).toMatchObject({
      paymentIntentId: quoted.intentId,
      actorId: alice.userId,
      state: 'quoted',
      currency: TEST_CURRENCY,
      requestedAmountMinor: 1000n,
      currentQuoteId: quoted.quoteId,
    });
    const foreign = await h.intents.findOwnedById(quoted.intentId, bob.userId);
    expect(foreign).toBeNull();
    const found = await h.intents.findById(quoted.intentId);
    expect(found?.state).toBe('quoted');
  });

  it('rejects an intent whose route does not match an active same-currency bank link', async () => {
    const [alice] = seed.users;
    if (!alice) {
      throw new Error('seed identity failed');
    }
    const intentId = testUuid();
    const quoteId = testUuid();
    await expectPgError(
      () =>
        h.intents.createIntentWithQuote({
          paymentIntentId: intentId,
          actorId: alice.userId,
          sourceBankLinkId: alice.bankLinkId,
          recipientAliasId: alice.aliasId,
          currency: 'USD',
          requestedAmountMinor: 1000n,
          quote: {
            quoteId,
            providerKey: 'sim-dfsp',
            partnerQuoteRef: 'pqr-' + quoteId,
            apiProfile: 'SIMULATOR',
            quotedFeeMinor: 1n,
            feeRuleVersion: 'flat-1',
            issuedAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            bindingDigest: sha256Hex('binding:' + quoteId),
            requestDigest: sha256Hex('quote-request:' + quoteId),
          },
          correlationId: testUuid(),
        }),
      '23514',
    );
  });

  it('confirms a quote-bound intent and produces exactly one durable outbox command', async () => {
    const [alice] = seed.users;
    if (!alice) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const result = await h.intents.confirmPaymentIntent({
      actorId: alice.userId,
      paymentIntentId: quoted.intentId,
      quoteId: quoted.quoteId,
      bindingDigest: quoted.bindingDigest,
      requestDigest: quoted.requestDigest,
      idempotencyKeyDigest: sha256Hex('confirm-key-1'),
      authorizationEvidenceRef: 'authz-simulator-' + quoted.intentId,
      correlationId: testUuid(),
    });
    expect(result).toMatchObject({
      paymentIntentId: quoted.intentId,
      state: 'user_authorized',
      replayed: false,
    });
    const record = await h.intents.findOwnedById(quoted.intentId, alice.userId);
    expect(record?.state).toBe('user_authorized');
    expect(await countRows(h, 'outbox_messages', "aggregate_id = '" + quoted.intentId + "'")).toBe(
      1,
    );
    expect(await countRows(h, 'idempotency_records')).toBe(1);
    const quote = await h.intents.findCurrentQuote(quoted.intentId);
    expect(quote?.bindingDigest).toBe(quoted.bindingDigest);
    expect(quote?.payerDebitMinor).toBe(1001n);
  });

  it('parallel confirms with different keys produce exactly one outbox command', async () => {
    const [alice] = seed.users;
    if (!alice) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const confirm = (key: string) =>
      h.intents.confirmPaymentIntent({
        actorId: alice.userId,
        paymentIntentId: quoted.intentId,
        quoteId: quoted.quoteId,
        bindingDigest: quoted.bindingDigest,
        requestDigest: quoted.requestDigest,
        idempotencyKeyDigest: sha256Hex(key),
        authorizationEvidenceRef: 'authz-simulator-' + quoted.intentId,
        correlationId: testUuid(),
      });
    const settled = await Promise.allSettled([confirm('k-a'), confirm('k-b')]);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected');
    expect(rejected).toBeDefined();
    // The loser sees the intent already confirmed and aborts its whole transaction.
    await expectPgError(async () => {
      throw rejected?.reason ?? new Error('missing rejection');
    }, '55000');
    expect(await countRows(h, 'outbox_messages', "aggregate_id = '" + quoted.intentId + "'")).toBe(
      1,
    );
    expect(await countRows(h, 'idempotency_records')).toBe(1);
    const record = await h.intents.findOwnedById(quoted.intentId, alice.userId);
    expect(record?.state).toBe('user_authorized');
  });

  it('replays a same-key confirm without duplicate effects', async () => {
    const [alice] = seed.users;
    if (!alice) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const input = {
      actorId: alice.userId,
      paymentIntentId: quoted.intentId,
      quoteId: quoted.quoteId,
      bindingDigest: quoted.bindingDigest,
      requestDigest: quoted.requestDigest,
      idempotencyKeyDigest: sha256Hex('same-key'),
      authorizationEvidenceRef: 'authz-simulator-' + quoted.intentId,
      correlationId: testUuid(),
    };
    const first = await h.intents.confirmPaymentIntent(input);
    expect(first.replayed).toBe(false);
    const replay = await h.intents.confirmPaymentIntent(input);
    expect(replay).toMatchObject({ paymentIntentId: quoted.intentId, replayed: true });
    expect(await countRows(h, 'outbox_messages', "aggregate_id = '" + quoted.intentId + "'")).toBe(
      1,
    );
    // Parallel same-key confirms also stay single-effect.
    const settled = await Promise.allSettled([
      h.intents.confirmPaymentIntent(input),
      h.intents.confirmPaymentIntent(input),
    ]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    expect(await countRows(h, 'outbox_messages', "aggregate_id = '" + quoted.intentId + "'")).toBe(
      1,
    );
  });

  it('rejects key reuse with a different request', async () => {
    const [alice] = seed.users;
    if (!alice) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const base = {
      actorId: alice.userId,
      paymentIntentId: quoted.intentId,
      quoteId: quoted.quoteId,
      bindingDigest: quoted.bindingDigest,
      idempotencyKeyDigest: sha256Hex('reused-key'),
      authorizationEvidenceRef: 'authz-simulator-' + quoted.intentId,
      correlationId: testUuid(),
    };
    await h.intents.confirmPaymentIntent({ ...base, requestDigest: sha256Hex('request-a') });
    await expectPgError(
      () => h.intents.confirmPaymentIntent({ ...base, requestDigest: sha256Hex('request-b') }),
      '22023',
    );
  });

  it('rejects confirmation by a non-owner, with a wrong binding, and after quote expiry', async () => {
    const [alice, bob] = seed.users;
    if (!alice || !bob) {
      throw new Error('seed identity failed');
    }
    const quoted = await seedQuotedIntent(h, alice);
    const confirmInput = (actorId: string, bindingDigest: string) => ({
      actorId,
      paymentIntentId: quoted.intentId,
      quoteId: quoted.quoteId,
      bindingDigest,
      requestDigest: quoted.requestDigest,
      idempotencyKeyDigest: sha256Hex('key-' + actorId),
      authorizationEvidenceRef: 'authz-simulator-' + quoted.intentId,
      correlationId: testUuid(),
    });
    await expectPgError(
      () => h.intents.confirmPaymentIntent(confirmInput(bob.userId, quoted.bindingDigest)),
      '42501',
    );
    await expectPgError(
      () => h.intents.confirmPaymentIntent(confirmInput(alice.userId, sha256Hex('wrong-binding'))),
      '22023',
    );
    const expired = await seedQuotedIntent(h, alice, {
      issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_800_000).toISOString(),
    });
    await expectPgError(
      () =>
        h.intents.confirmPaymentIntent({
          actorId: alice.userId,
          paymentIntentId: expired.intentId,
          quoteId: expired.quoteId,
          bindingDigest: expired.bindingDigest,
          requestDigest: expired.requestDigest,
          idempotencyKeyDigest: sha256Hex('key-expired'),
          authorizationEvidenceRef: 'authz-simulator-' + expired.intentId,
          correlationId: testUuid(),
        }),
      '22023',
    );
  });
});
