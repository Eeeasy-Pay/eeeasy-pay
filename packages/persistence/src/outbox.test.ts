// TICKET-004 acceptance: transactional outbox. Enqueue rolls back with its command
// transaction; claim/finish honor the lease token exactly (migration 0003 semantics).

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  countRows,
  createHarness,
  databaseUrl,
  testUuid,
  truncateAll,
  type Harness,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('outbox persistence', () => {
  const h: Harness = createHarness(databaseUrl);

  beforeEach(async () => {
    await truncateAll(h);
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  function enqueueCommand(idempotencyKey: string): {
    promise: Promise<string>;
    safePayload: Record<string, string>;
  } {
    const paymentIntentId = testUuid();
    const safePayload = {
      payment_intent_id: paymentIntentId,
      correlation_id: testUuid(),
      quote_binding_sha256: sha256Hex('binding:' + idempotencyKey),
    };
    return {
      promise: h.outbox.enqueue({
        aggregateType: 'payment_intent',
        aggregateId: paymentIntentId,
        commandType: 'submit_payment',
        schemaVersion: 1,
        idempotencyKeyDigest: sha256Hex(idempotencyKey),
        payloadDigest: sha256Hex('payload:' + idempotencyKey),
        safePayload,
      }),
      safePayload,
    };
  }

  it('enqueues inside a transaction and disappears when the transaction rolls back', async () => {
    const messagePromise = h.transactions.run(async () => {
      const { promise } = enqueueCommand('rollback-key');
      const id = await promise;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      throw new Error('boom: command failed');
    });
    await expect(messagePromise).rejects.toThrow('boom: command failed');
    expect(await countRows(h, 'outbox_messages')).toBe(0);
  });

  it('claims with a lease and publishes exactly once with the correct lease token', async () => {
    const { promise, safePayload } = enqueueCommand('happy-key');
    const messageId = await promise;
    const claimed = await h.outbox.claim({ workerId: 'worker-1', limit: 5, leaseSeconds: 60 });
    expect(claimed).toHaveLength(1);
    const message = claimed[0];
    if (!message) {
      throw new Error('claim returned no message');
    }
    expect(message.outboxMessageId).toBe(messageId);
    expect(message.state).toBe('leased');
    expect(message.attempts).toBe(1);
    expect(message.leaseOwner).toBe('worker-1');
    expect(message.leaseToken ?? '').toMatch(/^[0-9a-f-]{36}$/);
    expect(message.idempotencyKeyDigest).toBe(sha256Hex('happy-key'));
    expect(message.commandType).toBe('submit_payment');
    expect(message.safePayload).toEqual(safePayload);
    expect(message.availableAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // A second claim finds nothing available.
    expect(await h.outbox.claim({ workerId: 'worker-2', limit: 5, leaseSeconds: 60 })).toHaveLength(0);
    // Wrong lease token must not finish the message.
    const wrongToken = await h.outbox.finish({
      outboxMessageId: messageId,
      workerId: 'worker-1',
      leaseToken: testUuid(),
      published: true,
    });
    expect(wrongToken).toBe(false);
    // Correct token publishes it exactly once.
    const ok = await h.outbox.finish({
      outboxMessageId: messageId,
      workerId: 'worker-1',
      leaseToken: message.leaseToken ?? '',
      published: true,
    });
    expect(ok).toBe(true);
    const states = await h.sql<{ state: string }[]>`
      SELECT state FROM public.outbox_messages WHERE outbox_message_id = ${messageId}::uuid`;
    expect(states[0]?.state).toBe('published');
    expect(await h.outbox.claim({ workerId: 'worker-1', limit: 5, leaseSeconds: 60 })).toHaveLength(0);
  });

  it('retries with a backoff schedule and dead-letters when no retry is possible', async () => {
    const { promise } = enqueueCommand('retry-key');
    const messageId = await promise;
    const first = await h.outbox.claim({ workerId: 'worker-1', limit: 5, leaseSeconds: 60 });
    const leaseToken = first[0]?.leaseToken;
    if (!leaseToken) {
      throw new Error('claim returned no lease token');
    }
    const retried = await h.outbox.finish({
      outboxMessageId: messageId,
      workerId: 'worker-1',
      leaseToken,
      published: false,
      retryAt: new Date(Date.now() + 30_000).toISOString(),
      errorCode: 'sim_unavailable',
    });
    expect(retried).toBe(true);
    const pending = await h.outbox.claim({ workerId: 'worker-1', limit: 5, leaseSeconds: 60 });
    expect(pending).toHaveLength(0); // available_at is in the future
    const released = await h.sql`
      UPDATE public.outbox_messages SET available_at = now()
      WHERE outbox_message_id = ${messageId}::uuid`;
    expect(released.count).toBe(1);
    const second = await h.outbox.claim({ workerId: 'worker-1', limit: 5, leaseSeconds: 60 });
    expect(second).toHaveLength(1);
    expect(second[0]?.attempts).toBe(2);
    const dead = await h.outbox.finish({
      outboxMessageId: messageId,
      workerId: 'worker-1',
      leaseToken: second[0]?.leaseToken ?? '',
      published: false,
      errorCode: 'permanent_failure',
    });
    expect(dead).toBe(true);
    const states = await h.sql<{ state: string }[]>`
      SELECT state FROM public.outbox_messages WHERE outbox_message_id = ${messageId}::uuid`;
    expect(states[0]?.state).toBe('dead_letter');
  });
});
