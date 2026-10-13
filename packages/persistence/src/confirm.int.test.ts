import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Db } from './db.ts';
import {
  IdempotencyConflictError,
  PaymentIntentNotFoundError,
  PaymentStateConflictError,
  QuoteNotBindableError,
} from '@eeeasy-pay/ports';
import { sha256Hex } from '@eeeasy-pay/pal';
import { bufferToHex } from './hex.ts';
import {
  deterministicId,
  seedQuotedIntent,
  seedUser,
  type SeededQuotedIntent,
} from './int-helpers.ts';
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

const USER_A = deterministicId('user', 'confirm-a');
const USER_B = deterministicId('user', 'confirm-b');

async function count(where: string, params: unknown[]): Promise<number> {
  const result = await db.query<{ n: string }>(`SELECT count(*)::text AS n ${where}`, params);
  return Number(result.rows[0]?.n ?? '0');
}

function confirmCommand(
  seeded: SeededQuotedIntent,
  actorId: string,
  keyRef: string,
  requestRef: string = keyRef,
) {
  return {
    actorId,
    paymentIntentId: seeded.paymentIntentId,
    quoteId: seeded.quoteId,
    quoteBindingDigest: seeded.bindingDigest,
    requestDigest: sha256Hex('confirm-request:' + requestRef),
    idempotencyKeyDigest: sha256Hex('confirm-key:' + keyRef),
    authorizationEvidenceRef: 'sim-authorization-evidence',
    correlationId: deterministicId('correlation', requestRef),
  };
}

beforeAll(async () => {
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
});

afterAll(async () => {
  await pool.end();
});

describe('payment intent + quote repositories', () => {
  it('round-trips a quoted intent with ownership isolation', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-roundtrip' });

    const owned = await stores.intents.findOwnedById(seeded.paymentIntentId, USER_A);
    expect(owned).toMatchObject({
      paymentIntentId: seeded.paymentIntentId,
      actorId: USER_A,
      state: 'quoted',
      currentQuoteId: seeded.quoteId,
    });
    expect(owned?.requestedAmountMinor).toBe(1000n);

    const byId = await stores.intents.findById(seeded.paymentIntentId);
    expect(byId?.state).toBe('quoted');

    // Another actor sees the same result as a missing id: no cross-actor read (enumeration
    // resistance), and the digest-bearing columns never leave the service path.
    await expect(stores.intents.findOwnedById(seeded.paymentIntentId, USER_B)).resolves.toBeNull();
  });

  it('round-trips the stored quote with its binding digest', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-quote-rt' });
    const quote = await stores.quotes.findQuoteById(seeded.quoteId);
    expect(quote).toMatchObject({
      quoteId: seeded.quoteId,
      paymentIntentId: seeded.paymentIntentId,
      currency: 'XTS',
      feeRuleVersion: 'simulator-flat-1',
    });
    expect(quote?.requestedAmountMinor).toBe(1000n);
    expect(quote?.quotedFeeMinor).toBe(1n);
    expect(quote?.payerDebitMinor).toBe(1001n);
    expect(quote?.recipientAmountMinor).toBe(1000n);
    expect(quote?.bindingDigest).toBe(seeded.bindingDigest);
    await expect(stores.quotes.findQuoteById(deterministicId('quote', 'missing'))).resolves.toBeNull();
  });

  it('rejects attaching a second quote to the same intent', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-attach' });
    const otherQuoteId = deterministicId('quote', 'confirm-attach-other');
    await expect(
      stores.intents.attachQuote(seeded.paymentIntentId, otherQuoteId),
    ).rejects.toBeInstanceOf(PaymentStateConflictError);
  });
});

describe('confirm command (atomic, single-threaded)', () => {
  it('commits idempotency + authorized intent + event + outbox together', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-happy' });
    const command = confirmCommand(seeded, USER_A, 'confirm-happy');

    const outcome = await stores.commands.confirmPaymentIntent(command);
    expect(outcome).toEqual({
      replayed: false,
      paymentIntentId: seeded.paymentIntentId,
      state: 'user_authorized',
    });

    const intent = await stores.intents.findOwnedById(seeded.paymentIntentId, USER_A);
    expect(intent?.state).toBe('user_authorized');

    // Exactly one durable outbox command, keyed by the confirmation idempotency digest.
    const outbox = await db.query<{
      command_type: string;
      idempotency_key_sha256: Buffer;
      safe_payload: Record<string, unknown>;
    }>(
      'SELECT command_type, idempotency_key_sha256, safe_payload FROM public.outbox_messages WHERE aggregate_id = $1',
      [seeded.paymentIntentId],
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.command_type).toBe('submit_payment');
    expect(bufferToHex(outbox.rows[0]?.idempotency_key_sha256 ?? new Uint8Array())).toBe(
      command.idempotencyKeyDigest,
    );
    expect(outbox.rows[0]?.safe_payload['quote_binding_sha256']).toBe(seeded.bindingDigest);

    // Exactly one append-only UserAuthorized event.
    expect(
      await count(
        'FROM public.payment_events WHERE payment_intent_id = $1 AND event_type = $2',
        [seeded.paymentIntentId, 'UserAuthorized'],
      ),
    ).toBe(1);

    // The idempotency record reached 'accepted'.
    const idem = await db.query<{ record_state: string }>(
      `SELECT record_state FROM public.idempotency_records
        WHERE actor_user_id = $1 AND operation = 'confirm-payment' AND key_sha256 = $2`,
      [USER_A, Buffer.from(command.idempotencyKeyDigest, 'hex')],
    );
    expect(idem.rows[0]?.record_state).toBe('accepted');

    // Replay with the same key + request returns the prior outcome, no duplicate effects.
    const replay = await stores.commands.confirmPaymentIntent(command);
    expect(replay.replayed).toBe(true);
    expect(replay.paymentIntentId).toBe(seeded.paymentIntentId);
    expect(
      await count('FROM public.outbox_messages WHERE aggregate_id = $1', [seeded.paymentIntentId]),
    ).toBe(1);
    expect(
      await count('FROM public.payment_events WHERE payment_intent_id = $1', [seeded.paymentIntentId]),
    ).toBe(1);
  });

  it('conflicts when the same key is reused with a different request', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-conflict' });
    const first = confirmCommand(seeded, USER_A, 'confirm-conflict');
    const conflicting = confirmCommand(seeded, USER_A, 'confirm-conflict', 'confirm-conflict-2');
    await stores.commands.confirmPaymentIntent(first);
    await expect(stores.commands.confirmPaymentIntent(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
  });

  it('rejects a confirm with a fresh key once the intent left the quoted state', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-state' });
    await stores.commands.confirmPaymentIntent(confirmCommand(seeded, USER_A, 'confirm-state'));
    await expect(
      stores.commands.confirmPaymentIntent(confirmCommand(seeded, USER_A, 'confirm-state-2')),
    ).rejects.toBeInstanceOf(PaymentStateConflictError);
  });

  it('rejects another actor with the same result as a missing intent', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-actor' });
    await expect(
      stores.commands.confirmPaymentIntent(confirmCommand(seeded, USER_B, 'confirm-actor')),
    ).rejects.toBeInstanceOf(PaymentIntentNotFoundError);
    // The failed attempt left no idempotency row behind (atomic rollback).
    expect(
      await count('FROM public.idempotency_records WHERE actor_user_id = $1', [USER_B]),
    ).toBe(0);
  });

  it('rejects an expired quote without any mutation', async () => {
    const now = Date.now();
    const seeded = await seedQuotedIntent(db, stores, {
      userId: USER_A,
      ref: 'confirm-expired',
      issuedAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 60_000).toISOString(),
    });
    const command = confirmCommand(seeded, USER_A, 'confirm-expired');
    await expect(stores.commands.confirmPaymentIntent(command)).rejects.toBeInstanceOf(
      QuoteNotBindableError,
    );
    const intent = await stores.intents.findOwnedById(seeded.paymentIntentId, USER_A);
    expect(intent?.state).toBe('quoted');
    expect(
      await count('FROM public.outbox_messages WHERE aggregate_id = $1', [seeded.paymentIntentId]),
    ).toBe(0);
    // Atomic rollback: the failed attempt left no idempotency record for this key.
    expect(
      await count('FROM public.idempotency_records WHERE key_sha256 = $1', [
        Buffer.from(command.idempotencyKeyDigest, 'hex'),
      ]),
    ).toBe(0);
  });
});

describe('confirm command under concurrency', () => {
  it('produces exactly one durable outbox command for N parallel confirmations', async () => {
    const seeded = await seedQuotedIntent(db, stores, { userId: USER_A, ref: 'confirm-race' });
    const command = confirmCommand(seeded, USER_A, 'confirm-race');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => stores.commands.confirmPaymentIntent(command)),
    );
    expect(results).toHaveLength(8);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(7);
    for (const outcome of results) {
      expect(outcome.paymentIntentId).toBe(seeded.paymentIntentId);
    }

    // No duplicate effects: one outbox command, one event, one authorized intent.
    expect(
      await count('FROM public.outbox_messages WHERE aggregate_id = $1', [seeded.paymentIntentId]),
    ).toBe(1);
    expect(
      await count('FROM public.payment_events WHERE payment_intent_id = $1', [seeded.paymentIntentId]),
    ).toBe(1);
    const intent = await stores.intents.findOwnedById(seeded.paymentIntentId, USER_A);
    expect(intent?.state).toBe('user_authorized');
  });
});

describe('idempotency repository (direct table port)', () => {
  it('reserves, replays, conflicts, and walks record states', async () => {
    const keyDigest = sha256Hex('idem-port-key');
    const requestDigest = sha256Hex('idem-port-request-1');
    const resourceRef = deterministicId('resource', 'idem-port');

    const reserved = await stores.idempotency.reserve({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
      requestDigest,
      resourceRef,
    });
    expect(reserved).toEqual({ replayed: false, requestMatched: true, resourceRef });

    const replay = await stores.idempotency.reserve({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
      requestDigest,
      resourceRef,
    });
    expect(replay).toEqual({ replayed: true, requestMatched: true, resourceRef });

    const conflicting = await stores.idempotency.reserve({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
      requestDigest: sha256Hex('idem-port-request-2'),
      resourceRef,
    });
    expect(conflicting.replayed).toBe(true);
    expect(conflicting.requestMatched).toBe(false);

    const stateQuery = async (): Promise<string | undefined> => {
      const result = await db.query<{ record_state: string }>(
        `SELECT record_state FROM public.idempotency_records
          WHERE actor_user_id = $1 AND operation = $2 AND key_sha256 = $3`,
        [USER_A, 'create-payment-intent', Buffer.from(keyDigest, 'hex')],
      );
      return result.rows[0]?.record_state;
    };

    await stores.idempotency.markAccepted({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
    });
    expect(await stateQuery()).toBe('accepted');
    await stores.idempotency.markCompleted({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
    });
    expect(await stateQuery()).toBe('completed');
    await stores.idempotency.markFailed({
      actorId: USER_A,
      operation: 'create-payment-intent',
      keyDigest,
    });
    expect(await stateQuery()).toBe('failed');
  });
});

describe('transaction boundary', () => {
  it('commits repository writes made inside run()', async () => {
    await stores.transactions.run(async () => {
      await stores.outbox.enqueue({
        aggregateType: 'payment_intent',
        aggregateId: deterministicId('aggregate', 'tx-commit'),
        commandType: 'sim_command',
        schemaVersion: 1,
        idempotencyKeyDigest: sha256Hex('tx-commit-1'),
        payloadDigest: sha256Hex('tx-commit-payload-1'),
        safePayload: { note: 'simulator' },
      });
      await stores.outbox.enqueue({
        aggregateType: 'payment_intent',
        aggregateId: deterministicId('aggregate', 'tx-commit'),
        commandType: 'sim_command',
        schemaVersion: 1,
        idempotencyKeyDigest: sha256Hex('tx-commit-2'),
        payloadDigest: sha256Hex('tx-commit-payload-2'),
        safePayload: { note: 'simulator' },
      });
    });
    expect(
      await count(
        'FROM public.outbox_messages WHERE idempotency_key_sha256 IN ($1, $2)',
        [Buffer.from(sha256Hex('tx-commit-1'), 'hex'), Buffer.from(sha256Hex('tx-commit-2'), 'hex')],
      ),
    ).toBe(2);
  });

  it('rolls back every repository write when the operation throws', async () => {
    await expect(
      stores.transactions.run(async () => {
        await stores.outbox.enqueue({
          aggregateType: 'payment_intent',
          aggregateId: deterministicId('aggregate', 'tx-rollback'),
          commandType: 'sim_command',
          schemaVersion: 1,
          idempotencyKeyDigest: sha256Hex('tx-rollback'),
          payloadDigest: sha256Hex('tx-rollback-payload'),
          safePayload: { note: 'simulator' },
        });
        throw new Error('simulated failure inside the transaction');
      }),
    ).rejects.toThrow('simulated failure inside the transaction');
    expect(
      await count('FROM public.outbox_messages WHERE idempotency_key_sha256 = $1', [
        Buffer.from(sha256Hex('tx-rollback'), 'hex'),
      ]),
    ).toBe(0);
  });

  it('rejects nested transactions instead of silently using savepoints', async () => {
    await expect(
      stores.transactions.run(async () => {
        await stores.transactions.run(async () => 'inner');
      }),
    ).rejects.toThrow(/nested transactions are not supported/);
  });
});
