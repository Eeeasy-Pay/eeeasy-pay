import type {
  OutboxSubmissionEvidence,
  PaymentEventAppend,
  PaymentEventRepository,
  ReconciliationEvidence,
  SubmissionEvidenceRepository,
} from '@eeeasy-pay/ports';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { hexToBuffer } from './hex.ts';

/**
 * Append-only writes to payment_events. The table's reject_mutation trigger enforces
 * immutability at the database level; this repository never issues UPDATE or DELETE.
 */
export class PostgresPaymentEventRepository
  implements PaymentEventRepository, SubmissionEvidenceRepository
{
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

  async findSubmissionByOutboxMessage(
    paymentIntentId: string,
    outboxMessageId: string,
  ): Promise<OutboxSubmissionEvidence | null> {
    const result = await this.db.query<{
      external_event_id: string | null;
      safe_metadata: Record<string, unknown>;
    }>(
      `SELECT external_event_id, safe_metadata
         FROM public.payment_events
        WHERE payment_intent_id = $1
          AND event_type = $2
          AND source_system = $3
          AND safe_metadata->>'outbox_message_id' = $4
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [
        paymentIntentId,
        WORKER_SUBMISSION_EVENT.eventType,
        WORKER_SUBMISSION_EVENT.sourceSystem,
        outboxMessageId,
      ],
    );
    const row = result.rows[0];
    const outcome = row?.safe_metadata['outcome'];
    if (!row || row.external_event_id === null || typeof outcome !== 'string') {
      return null;
    }
    if (outcome !== 'committed' && outcome !== 'rejected' && outcome !== 'timeout_unknown') {
      return null;
    }
    return { outboxMessageId, externalTransferId: row.external_event_id, outcome };
  }

  async findReconciliationByExternalId(
    externalTransferId: string,
  ): Promise<ReconciliationEvidence | null> {
    const result = await this.db.query<{ safe_metadata: Record<string, unknown> }>(
      `SELECT safe_metadata
         FROM public.payment_events
        WHERE event_type = $1
          AND source_system = $2
          AND external_event_id = $3
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [
        WORKER_RECONCILIATION_EVENT.eventType,
        WORKER_RECONCILIATION_EVENT.sourceSystem,
        externalTransferId,
      ],
    );
    const row = result.rows[0];
    const status = row?.safe_metadata['query_status'];
    if (!row || (status !== 'committed' && status !== 'rejected')) {
      return null;
    }
    return { externalTransferId, resolvedStatus: status };
  }
}
