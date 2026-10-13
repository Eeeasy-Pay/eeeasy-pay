import type { OutboxMessageRecord, OutboxRepository } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { bufferToHex, hexToBuffer } from './hex.ts';

/** Raw outbox_messages row as returned by node-postgres (snake_case columns). */
export interface OutboxRow {
  outbox_message_id: string;
  aggregate_type: string;
  aggregate_id: string;
  command_type: string;
  schema_version: number;
  idempotency_key_sha256: Buffer;
  payload_sha256: Buffer;
  safe_payload: Record<string, unknown>;
  state: 'pending' | 'leased' | 'published' | 'dead_letter';
  attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
}

/** Pure row mapper (unit-testable without a database). */
export function mapOutboxRow(row: OutboxRow): OutboxMessageRecord {
  return {
    outboxMessageId: row.outbox_message_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    commandType: row.command_type,
    schemaVersion: row.schema_version,
    idempotencyKeyDigest: bufferToHex(row.idempotency_key_sha256),
    payloadDigest: bufferToHex(row.payload_sha256),
    safePayload: row.safe_payload,
    state: row.state,
    attempts: row.attempts,
    availableAt: new Date(row.available_at).toISOString(),
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
  };
}

/**
 * Outbox enqueue is a direct INSERT reserved for trusted transactional command code
 * (service_role grant); claim and finish run exclusively through the reviewed
 * app_private functions so lease ownership stays single-writer.
 */
export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly db: Db) {}

  async enqueue(input: {
    aggregateType: string;
    aggregateId: string;
    commandType: string;
    schemaVersion: number;
    idempotencyKeyDigest: string;
    payloadDigest: string;
    safePayload: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const result = await this.db.query<{ outbox_message_id: string }>(
      `INSERT INTO public.outbox_messages
         (aggregate_type, aggregate_id, command_type, schema_version,
          idempotency_key_sha256, payload_sha256, safe_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING outbox_message_id`,
      [
        input.aggregateType,
        input.aggregateId,
        input.commandType,
        input.schemaVersion,
        hexToBuffer(input.idempotencyKeyDigest),
        hexToBuffer(input.payloadDigest),
        JSON.stringify(input.safePayload),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('enqueue did not return an outbox_message_id');
    }
    return row.outbox_message_id;
  }

  async claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<OutboxMessageRecord[]> {
    const result = await this.db.query<OutboxRow>(
      'SELECT * FROM app_private.claim_outbox($1, $2, $3)',
      [input.workerId, input.limit, input.leaseSeconds],
    );
    return result.rows.map(mapOutboxRow);
  }

  async finish(input: {
    outboxMessageId: string;
    workerId: string;
    leaseToken: string;
    published: boolean;
    retryAt?: string;
    errorCode?: string;
  }): Promise<boolean> {
    const result = await this.db.query<{ finished: boolean }>(
      `SELECT app_private.finish_outbox($1, $2, $3, $4, $5, $6) AS finished`,
      [
        input.outboxMessageId,
        input.workerId,
        input.leaseToken,
        input.published,
        input.retryAt ?? null,
        input.errorCode ?? null,
      ],
    );
    const row = result.rows[0];
    return row?.finished === true;
  }
}
