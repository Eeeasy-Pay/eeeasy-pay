// Inbox repository over the reviewed ingest_provider_event function (migration 0003).
// Deduplication on (provider_key, provider_event_id) is enforced atomically by the
// function; a CHANGED payload under the same event id is rejected (ADR-006).

import type { InboxRepository } from '@eeeasy-pay/ports';
import { hexToBuffer, jsonbParameter, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

export class PostgresInboxRepository implements InboxRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  async ingest(event: {
    providerKey: string;
    providerEventId: string;
    payloadDigest: string;
    schemaVersion: number;
    paymentIntentId?: string;
    correlationId?: string;
    authenticatedPrincipal: string;
    normalizedPayload: Readonly<Record<string, unknown>>;
  }): Promise<{ inboxEventId: string; replayed: boolean }> {
    const db = this.db;
    const existing = await db<{ inbox_event_id: string }[]>`
      SELECT inbox_event_id FROM public.inbox_events
      WHERE provider_key = ${event.providerKey} AND provider_event_id = ${event.providerEventId}`;
    const rows = await db<{ id: string }[]>`
      SELECT app_private.ingest_provider_event(
        ${event.providerKey}, ${event.providerEventId}, ${hexToBuffer(event.payloadDigest)},
        ${event.schemaVersion}, ${event.paymentIntentId ?? null}::uuid,
        ${event.correlationId ?? null}::uuid, ${event.authenticatedPrincipal},
        ${jsonbParameter(db, event.normalizedPayload)}) AS id`;
    const id = rows[0]?.id;
    if (!id) {
      throw new Error('ingest_provider_event returned no id');
    }
    return { inboxEventId: id, replayed: existing.length > 0 };
  }
}

