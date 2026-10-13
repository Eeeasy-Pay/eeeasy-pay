// TICKET-004 acceptance: inbox dedupe. Same (provider, event id) + payload replays the
// same row; a CHANGED payload under the same event id is rejected; parallel ingests
// never create a second row (ADR-006).

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { sha256Hex } from '@eeeasy-pay/pal';
import {
  countRows,
  createHarness,
  databaseUrl,
  expectPgError,
  seedIdentity,
  seedQuotedIntent,
  testUuid,
  truncateAll,
  type Harness,
  type Seed,
  type SeedUser,
} from './test-support.ts';

describe.skipIf(!databaseUrl)('inbox persistence', () => {
  const h: Harness = createHarness(databaseUrl);
  let seed: Seed;
  let alice: SeedUser;

  beforeEach(async () => {
    await truncateAll(h);
    seed = await seedIdentity(h, 1);
    const user = seed.users[0];
    if (!user) {
      throw new Error('seed identity failed');
    }
    alice = user;
  });

  afterAll(async () => {
    await h.sql.end({ timeout: 5 });
  });

  function ingestEvent(eventId: string, payloadDigest: string) {
    return h.inbox.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: eventId,
      payloadDigest,
      schemaVersion: 1,
      authenticatedPrincipal: 'sim-hmac',
      normalizedPayload: { event: eventId, kind: 'transfer_state' },
    });
  }

  it('deduplicates the same provider event and replays the same row id', async () => {
    const digest = sha256Hex('inbox-payload-1');
    const first = await ingestEvent('evt-1', digest);
    expect(first.replayed).toBe(false);
    const second = await ingestEvent('evt-1', digest);
    expect(second.inboxEventId).toBe(first.inboxEventId);
    expect(second.replayed).toBe(true);
    expect(await countRows(h, 'inbox_events')).toBe(1);
  });

  it('rejects a changed payload under the same event id', async () => {
    await ingestEvent('evt-2', sha256Hex('inbox-payload-2'));
    await expectPgError(() => ingestEvent('evt-2', sha256Hex('inbox-payload-changed')), '22023');
    expect(await countRows(h, 'inbox_events')).toBe(1);
  });

  it('ingests the same event in parallel exactly once', async () => {
    const digest = sha256Hex('inbox-payload-3');
    const settled = await Promise.allSettled([
      ingestEvent('evt-3', digest),
      ingestEvent('evt-3', digest),
    ]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);
    const ids = settled.flatMap((s) =>
      s.status === 'fulfilled' ? [s.value.inboxEventId] : [],
    );
    expect(new Set(ids).size).toBe(1);
    expect(await countRows(h, 'inbox_events')).toBe(1);
  });

  it('references an existing payment intent when one is provided', async () => {
    const quoted = await seedQuotedIntent(h, alice);
    const result = await h.inbox.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: 'evt-4',
      payloadDigest: sha256Hex('inbox-payload-4'),
      schemaVersion: 1,
      paymentIntentId: quoted.intentId,
      correlationId: testUuid(),
      authenticatedPrincipal: 'sim-hmac',
      normalizedPayload: { event: 'evt-4', kind: 'transfer_state' },
    });
    expect(result.replayed).toBe(false);
    const rows = await h.sql<{ payment_intent_id: string }[]>`
      SELECT payment_intent_id FROM public.inbox_events
      WHERE provider_key = 'sim-dfsp' AND provider_event_id = 'evt-4'`;
    expect(rows[0]?.payment_intent_id).toBe(quoted.intentId);
  });
});

