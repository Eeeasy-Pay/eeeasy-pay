// Outbox repository over the reviewed outbox_messages table and the SECURITY DEFINER
// claim/finish functions (migration 0003). Enqueue MUST run inside the same transaction
// as the command that produced it (ADR-006); claim/finish are worker-side operations.

import type { OutboxMessageRecord, OutboxRepository } from '@eeeasy-pay/ports';
import { hexToBuffer, toHex, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

interface OutboxRow {
  outbox_message_id: string;
  aggregate_type: string;
  aggregate_id: string;
  command_type: string;
  schema_version: number;
  idempotency_key_sha256: Buffer;
  payload_sha256: Buffer;
  safe_payload: Record<string, unknown>;
  state: OutboxMessageRecord['state'];
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  available_at: Date;
}

function toOutboxRecord(row: OutboxRow): OutboxMessageRecord {
  return {
    outboxMessageId: row.outbox_message_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    commandType: row.command_type,
    schemaVersion: row.schema_version,
    idempotencyKeyDigest: toHex(row.idempotency_key_sha256),
    payloadDigest: toHex(row.payload_sha256),
    safePayload: row.safe_payload,
    state: row.state,
    attempts: row.attempts,
    ...(row.lease_owner !== null ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token !== null ? { leaseToken: row.lease_token } : {}),
    availableAt: row.available_at.toISOString(),
  };
}

export class PostgresOutboxRepository implements OutboxRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  async enqueue(input: {
    aggregateType: string;
    aggregateId: string;
    commandType: string;
    schemaVersion: number;
    idempotencyKeyDigest: string;
    payloadDigest: string;
    safePayload: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const rows = await this.db<{ outbox_message_id: string }[]>`
      INSERT INTO public.outbox_messages
        (aggregate_type, aggregate_id, command_type, schema_version,
         idempotency_key_sha256, payload_sha256, safe_payload)
      VALUES (${input.aggregateType}, ${input.aggregateId}::uuid, ${input.commandType},
        ${input.schemaVersion}, ${hexToBuffer(input.idempotencyKeyDigest)},
        ${hexToBuffer(input.payloadDigest)}, ${input.safePayload}::jsonb)
      RETURNING outbox_message_id`;
    const id = rows[0]?.outbox_message_id;
    if (!id) {
      throw new Error('outbox enqueue: insert returned no id');
    }
    return id;
  }

  async claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
  }): Promise<OutboxMessageRecord[]> {
    const rows = await this.db<OutboxRow[]>`
      SELECT * FROM app_private.claim_outbox(${input.workerId}, ${input.limit}, ${input.leaseSeconds})`;
    return rows.map(toOutboxRecord);
  }

  async finish(input: {
    outboxMessageId: string;
    workerId: string;
    leaseToken: string;
    published: boolean;
    retryAt?: string;
    errorCode?: string;
  }): Promise<boolean> {
    const rows = await this.db<{ ok: boolean }[]>`
      SELECT app_private.finish_outbox(${input.outboxMessageId}::uuid, ${input.workerId},
        ${input.leaseToken}::uuid, ${input.published},
        ${input.retryAt ?? null}::timestamptz, ${input.errorCode ?? null}::text) AS ok`;
    return rows[0]?.ok === true;
  }
}
