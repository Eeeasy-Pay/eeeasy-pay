import type { InboxRepository } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { mapDbErrorAsync } from './errors.ts';
import { hexToBuffer } from './hex.ts';

/**
 * Provider-event ingest through app_private.ingest_provider_event, the only granted insert
 * path for inbox_events (the table has no direct INSERT grant). The function dedupes on
 * (provider_key, provider_event_id) and raises on a payload-hash mismatch (ADR-006).
 *
 * The function's return value cannot distinguish a fresh ingest from a deduped replay,
 * so an existence pre-check sets the replayed flag; the unique constraint keeps the
 * ingest itself race-safe regardless of what the pre-check observed.
 */
export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly db: Db) {}

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
    return mapDbErrorAsync(async () => {
      const existing = await this.db.query<{ inbox_event_id: string }>(
        `SELECT inbox_event_id FROM public.inbox_events
          WHERE provider_key = $1 AND provider_event_id = $2`,
        [event.providerKey, event.providerEventId],
      );
      const result = await this.db.query<{ id: string }>(
        'SELECT app_private.ingest_provider_event($1, $2, $3, $4, $5, $6, $7, $8) AS id',
        [
          event.providerKey,
          event.providerEventId,
          hexToBuffer(event.payloadDigest),
          event.schemaVersion,
          event.paymentIntentId ?? null,
          event.correlationId ?? null,
          event.authenticatedPrincipal,
          JSON.stringify(event.normalizedPayload),
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('ingest_provider_event did not return an inbox event id');
      }
      return { inboxEventId: row.id, replayed: existing.rows.length > 0 };
    });
  }
}
