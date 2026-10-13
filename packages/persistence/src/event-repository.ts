import type { PaymentEventAppend, PaymentEventRepository } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { hexToBuffer } from './hex.ts';

/**
 * Append-only writes to payment_events. The table's reject_mutation trigger enforces
 * immutability at the database level; this repository never issues UPDATE or DELETE.
 */
export class PostgresPaymentEventRepository implements PaymentEventRepository {
  constructor(private readonly db: Db) {}

  async appendEvent(event: PaymentEventAppend): Promise<string> {
    const result = await this.db.query<{ payment_event_id: string }>(
      `INSERT INTO public.payment_events
         (payment_intent_id, event_type, schema_version, source_system, external_event_id,
          correlation_id, causation_id, occurred_at, previous_payment_state, next_payment_state,
          payload_sha256, privacy_class, safe_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING payment_event_id`,
      [
        event.paymentIntentId,
        event.eventType,
        event.schemaVersion,
        event.sourceSystem,
        event.externalEventId ?? null,
        event.correlationId,
        event.causationId ?? null,
        event.occurredAt ?? null,
        event.previousState ?? null,
        event.nextState ?? null,
        hexToBuffer(event.payloadDigest),
        event.privacyClass,
        JSON.stringify(event.safeMetadata),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('appendEvent did not return a payment_event_id');
    }
    return row.payment_event_id;
  }
}
