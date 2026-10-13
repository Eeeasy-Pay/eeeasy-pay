import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createPersistenceStores } from '@eeeasy-pay/persistence';
import type { PersistenceStores } from '@eeeasy-pay/persistence';
import { InboxIngestor } from './inbox.ts';

// Integration tests against a disposable Postgres database (TEST_DATABASE_URL) with
// ci/db/prepare.sql and all supabase/migrations applied. Never a real or shared
// environment (docs/implementation/GUARDRAILS.md).

const databaseUrl = process.env.TEST_DATABASE_URL;

const maybeDescribe = databaseUrl ? describe : describe.skip;

const pool = new Pool(databaseUrl ? { connectionString: databaseUrl } : {});
const stores: PersistenceStores = createPersistenceStores(pool);

interface InboxRowView {
  inbox_event_id: string;
  state: string;
  processed_at: Date | null;
}

async function inboxRow(providerEventId: string): Promise<InboxRowView | null> {
  const result = await stores.db.query<InboxRowView>(
    `SELECT inbox_event_id, state, processed_at
       FROM public.inbox_events
      WHERE provider_key = 'sim-dfsp' AND provider_event_id = $1`,
    [providerEventId],
  );
  return result.rows[0] ?? null;
}

maybeDescribe('InboxIngestor integration (disposable Postgres only)', () => {
  it('ingests a fresh event, deduplicates redeliveries, and marks it processed', async () => {
    const ingestor = new InboxIngestor({ inbox: stores.inbox });
    const first = await ingestor.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: 'evt-int-dedupe',
      schemaVersion: 1,
      authenticatedPrincipal: 'sim-callback-auth',
      normalizedPayload: { status: 'committed', reference: 'STX-000001' },
    });
    expect(first.disposition).toBe('ingested');
    const row = await inboxRow('evt-int-dedupe');
    expect(row?.state).toBe('processed');
    expect(row?.processed_at).not.toBeNull();

    const second = await ingestor.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: 'evt-int-dedupe',
      schemaVersion: 1,
      authenticatedPrincipal: 'sim-callback-auth',
      normalizedPayload: { status: 'committed', reference: 'STX-000001' },
    });
    expect(second.disposition).toBe('deduplicated');
    const unchanged = await inboxRow('evt-int-dedupe');
    expect(unchanged?.state).toBe('processed'); // dedupe never re-processes
  });

  it('quarantines a changed payload under the same event id without overwriting it', async () => {
    const ingestor = new InboxIngestor({ inbox: stores.inbox });
    await ingestor.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: 'evt-int-conflict',
      schemaVersion: 1,
      authenticatedPrincipal: 'sim-callback-auth',
      normalizedPayload: { status: 'committed', reference: 'STX-000002' },
    });
    const conflicting = await ingestor.ingest({
      providerKey: 'sim-dfsp',
      providerEventId: 'evt-int-conflict',
      schemaVersion: 1,
      authenticatedPrincipal: 'sim-callback-auth',
      normalizedPayload: { status: 'rejected' },
    });
    expect(conflicting.disposition).toBe('quarantined');
    if (conflicting.disposition !== 'quarantined') {
      throw new Error('expected quarantined');
    }
    expect(conflicting.providerEventId).toBe('evt-int-conflict');

    const row = await inboxRow('evt-int-conflict');
    expect(row?.state).toBe('quarantined');
    // The table CHECK pairs processed_at with the processed state: quarantined clears it.
    expect(row?.processed_at).toBeNull();

    // Exactly one row exists for the event id: the conflicting redelivery was not stored.
    const count = await stores.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.inbox_events WHERE provider_event_id = 'evt-int-conflict'`,
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  afterAll(async () => {
    await pool.end();
  });
});
