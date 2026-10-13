// Idempotency repository over the reviewed idempotency_records table (migration 0002).
// Server-side only: the table is not granted to anon/authenticated roles (GUARDRAILS.md #5).
// Digests are hex strings at the port boundary and bytea in storage.

import type { IdempotencyReplay, IdempotencyRepository } from '@eeeasy-pay/ports';
import { hexToBuffer, toHex, type DbLike } from './client.ts';
import type { PostgresTransactions } from './transactions.ts';

interface IdempotencyRow {
  idempotency_record_id: string;
  request_sha256: Buffer;
  resource_id: string | null;
}

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  private readonly tx: PostgresTransactions;

  constructor(transactions: PostgresTransactions) {
    this.tx = transactions;
  }

  private get db(): DbLike {
    return this.tx.client();
  }

  async reserve(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
    resourceRef?: string;
  }): Promise<IdempotencyReplay> {
    const key = hexToBuffer(input.keyDigest);
    const request = hexToBuffer(input.requestDigest);
    const db = this.db;
    const inserted = await db<IdempotencyRow[]>`
      INSERT INTO public.idempotency_records
        (actor_user_id, operation, key_sha256, request_sha256, resource_id, record_state)
      VALUES (${input.actorId}::uuid, ${input.operation}, ${key}, ${request},
        ${input.resourceRef ?? null}::uuid, 'reserved')
      ON CONFLICT (actor_user_id, operation, key_sha256) DO NOTHING
      RETURNING idempotency_record_id, request_sha256, resource_id`;
    if (inserted.length > 0) {
      return { replayed: false, requestMatched: true };
    }
    const existing = await db<IdempotencyRow[]>`
      SELECT idempotency_record_id, request_sha256, resource_id
      FROM public.idempotency_records
      WHERE actor_user_id = ${input.actorId}::uuid
        AND operation = ${input.operation}
        AND key_sha256 = ${key}`;
    const row = existing[0];
    if (!row) {
      throw new Error('idempotency reserve: conflicting key disappeared before replay read');
    }
    return {
      replayed: true,
      requestMatched: toHex(row.request_sha256) === input.requestDigest,
      ...(row.resource_id !== null ? { resourceRef: row.resource_id } : {}),
    };
  }

  async markAccepted(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
  }): Promise<void> {
    await this.mark(input, 'accepted');
  }

  async markCompleted(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
  }): Promise<void> {
    await this.mark(input, 'completed');
  }

  async markFailed(input: { actorId: string; operation: string; keyDigest: string }): Promise<void> {
    await this.mark(input, 'failed');
  }

  private async mark(
    input: { actorId: string; operation: string; keyDigest: string },
    recordState: 'accepted' | 'completed' | 'failed',
  ): Promise<void> {
    const key = hexToBuffer(input.keyDigest);
    await this.db`
      UPDATE public.idempotency_records
      SET record_state = ${recordState}::public.idempotency_state
      WHERE actor_user_id = ${input.actorId}::uuid
        AND operation = ${input.operation}
        AND key_sha256 = ${key}`;
  }
}
