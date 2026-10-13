import { describe, expect, it } from 'vitest';
import type { InboxRepository } from '@eeeasy-pay/ports';
import { InboxPayloadConflictError } from '@eeeasy-pay/ports';
import { InboxIngestor, type InboxIngestInput } from './inbox.ts';

type InboxEvent = Parameters<InboxRepository['ingest']>[0];

interface FakeRow {
  id: string;
  digest: string;
  state: 'received' | 'processing' | 'processed' | 'quarantined';
}

class FakeInboxStore implements InboxRepository {
  readonly rows = new Map<string, FakeRow>();
  readonly processed = new Set<string>();
  readonly quarantined = new Set<string>();
  ingestCalls = 0;
  failWith: Error | null = null;

  async ingest(event: InboxEvent): Promise<{ inboxEventId: string; replayed: boolean }> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.ingestCalls += 1;
    const key = event.providerKey + '\u0000' + event.providerEventId;
    const existing = this.rows.get(key);
    if (existing) {
      if (existing.digest !== event.payloadDigest) {
        throw new InboxPayloadConflictError();
      }
      return { inboxEventId: existing.id, replayed: true };
    }
    const id = 'inbox-' + String(this.rows.size + 1);
    this.rows.set(key, { id, digest: event.payloadDigest, state: 'received' });
    return { inboxEventId: id, replayed: false };
  }

  async markProcessed(inboxEventId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.id === inboxEventId) {
        row.state = 'processed';
        this.processed.add(inboxEventId);
        return true;
      }
    }
    return false;
  }

  async quarantine(providerKey: string, providerEventId: string): Promise<boolean> {
    const key = providerKey + '\u0000' + providerEventId;
    const row = this.rows.get(key);
    if (!row) {
      return false;
    }
    row.state = 'quarantined';
    this.quarantined.add(key);
    return true;
  }
}

function baseEvent(overrides: Partial<InboxIngestInput> = {}): InboxIngestInput {
  return {
    providerKey: 'sim-dfsp',
    providerEventId: 'evt-1',
    schemaVersion: 1,
    authenticatedPrincipal: 'sim-callback-auth',
    normalizedPayload: { status: 'committed', reference: 'STX-000001' },
    ...overrides,
  };
}

describe('InboxIngestor', () => {
  it('ingests a fresh event and marks it processed', async () => {
    const store = new FakeInboxStore();
    const ingestor = new InboxIngestor({ inbox: store });
    const result = await ingestor.ingest(baseEvent());
    expect(result.disposition).toBe('ingested');
    if (result.disposition !== 'ingested') {
      throw new Error('expected ingested');
    }
    expect(store.processed.has(result.inboxEventId)).toBe(true);
    expect(store.ingestCalls).toBe(1);
  });

  it('deduplicates an identical redelivery', async () => {
    const store = new FakeInboxStore();
    const ingestor = new InboxIngestor({ inbox: store });
    const first = await ingestor.ingest(baseEvent());
    const second = await ingestor.ingest(baseEvent());
    expect(second.disposition).toBe('deduplicated');
    if (first.disposition !== 'ingested' || second.disposition !== 'deduplicated') {
      throw new Error('expected ingested then deduplicated');
    }
    expect(second.inboxEventId).toBe(first.inboxEventId);
    expect(store.rows).toHaveLength(1);
    expect(store.processed).toHaveLength(1);
  });

  it('quarantines a changed payload under the same event id', async () => {
    const store = new FakeInboxStore();
    const ingestor = new InboxIngestor({ inbox: store });
    await ingestor.ingest(baseEvent());
    const conflicting = await ingestor.ingest(
      baseEvent({ normalizedPayload: { status: 'rejected' } }),
    );
    expect(conflicting.disposition).toBe('quarantined');
    if (conflicting.disposition !== 'quarantined') {
      throw new Error('expected quarantined');
    }
    expect(conflicting.providerKey).toBe('sim-dfsp');
    expect(conflicting.providerEventId).toBe('evt-1');
    expect(store.quarantined).toHaveLength(1);
    expect(store.rows).toHaveLength(1); // the original event was NOT overwritten
  });

  it('rethrows unexpected ingest errors', async () => {
    const store = new FakeInboxStore();
    store.failWith = new Error('db down');
    const ingestor = new InboxIngestor({ inbox: store });
    await expect(ingestor.ingest(baseEvent())).rejects.toThrow('db down');
    expect(store.quarantined).toHaveLength(0);
  });
});
