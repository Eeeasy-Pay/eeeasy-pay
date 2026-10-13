// TICKET-004: idempotency repository. Reserve/replay semantics are the server-scoped
// guard for every mutating operation (ADR-005): only the digest of the client key is
// stored, and a replayed key with a different request is surfaced as requestMatched=false.

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  createHarness,
  databaseUrl,
  seedIdentity,
  truncateAll,
  type Harness,
  type Seed,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('idempotency persistence', () => {
  const h: Harness = createHarness(databaseUrl);
  let seed: Seed;

  beforeEach(async () => {
    await truncateAll(h);
    seed = await seedIdentity(h, 2);
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  function actorId(): string {
    const user = seed.users[0];
    if (!user) {
      throw new Error('seed identity failed');
    }
    return user.userId;
  }

  it('reserves once and replays the same key with the same request', async () => {
    const input = {
      actorId: actorId(),
      operation: 'create-payment-intent',
      keyDigest: sha256Hex('client-key-1'),
      requestDigest: sha256Hex('request-body-1'),
      resourceRef: '00000000-0000-4000-8000-00000000ab01',
    };
    const first = await h.idempotency.reserve(input);
    expect(first).toEqual({ replayed: false, requestMatched: true });
    const replay = await h.idempotency.reserve(input);
    expect(replay).toEqual({ replayed: true, requestMatched: true, resourceRef: input.resourceRef });
  });

  it('flags key reuse with a different request', async () => {
    const actor = actorId();
    await h.idempotency.reserve({
      actorId: actor,
      operation: 'create-payment-intent',
      keyDigest: sha256Hex('client-key-2'),
      requestDigest: sha256Hex('request-body-2'),
    });
    const conflict = await h.idempotency.reserve({
      actorId: actor,
      operation: 'create-payment-intent',
      keyDigest: sha256Hex('client-key-2'),
      requestDigest: sha256Hex('request-body-changed'),
    });
    expect(conflict).toEqual({ replayed: true, requestMatched: false });
  });

  it('scopes keys per actor and tracks lifecycle states', async () => {
    const other = seed.users[1];
    const key = sha256Hex('shared-looking-key');
    const actor = actorId();
    const first = await h.idempotency.reserve({
      actorId: actor,
      operation: 'create-payment-intent',
      keyDigest: key,
      requestDigest: sha256Hex('request-body-3'),
    });
    expect(first.replayed).toBe(false);
    if (!other) {
      throw new Error('seed identity failed');
    }
    const sameKeyOtherActor = await h.idempotency.reserve({
      actorId: other.userId,
      operation: 'create-payment-intent',
      keyDigest: key,
      requestDigest: sha256Hex('request-body-3'),
    });
    expect(sameKeyOtherActor.replayed).toBe(false);
    await h.idempotency.markAccepted({ actorId: actor, operation: 'create-payment-intent', keyDigest: key });
    const afterAccept = await h.idempotency.reserve({
      actorId: actor,
      operation: 'create-payment-intent',
      keyDigest: key,
      requestDigest: sha256Hex('request-body-3'),
    });
    expect(afterAccept.replayed).toBe(true);
    await h.idempotency.markCompleted({ actorId: actor, operation: 'create-payment-intent', keyDigest: key });
    const rows = await h.sql<{ record_state: string }[]>`
      SELECT record_state FROM public.idempotency_records
      WHERE actor_user_id = ${actor}::uuid AND operation = 'create-payment-intent'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record_state).toBe('completed');
    await h.idempotency.markFailed({ actorId: actor, operation: 'create-payment-intent', keyDigest: key });
    const afterFail = await h.idempotency.reserve({
      actorId: actor,
      operation: 'create-payment-intent',
      keyDigest: key,
      requestDigest: sha256Hex('request-body-3'),
    });
    expect(afterFail).toEqual({ replayed: true, requestMatched: true });
  });
});
