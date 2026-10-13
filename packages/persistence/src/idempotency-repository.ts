import type { IdempotencyReplay, IdempotencyRepository } from '@eeeasy-pay/ports';
import type { Db } from './db.ts';
import { hexToBuffer } from './hex.ts';

interface IdempotencyRow {
  request_sha256: Buffer;
  resource_id: string | null;
}

/**
 * Mirrors the DB unique key (actor_user_id, operation, key_sha256) and the reviewed
 * confirm function's semantics: same key + same request replays the stored resource;
 * same key + different request reports requestMatched=false so the caller returns a
 * conflict (ADR-005). The confirm command path uses app_private.confirm_payment_intent
 * instead; this repository serves the other server-scoped operations.
 */
export class PostgresIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: Db) {}

  async reserve(input: {
    actorId: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
    resourceRef?: string;
  }): Promise<IdempotencyReplay> {
    const inserted = await this.db.query(
      `INSERT INTO public.idempotency_records
         (actor_user_id, operation, key_sha256, request_sha256, resource_id, record_state)
       VALUES ($1, $2, $3, $4, $5, 'reserved')
       ON CONFLICT (actor_user_id, operation, key_sha256) DO NOTHING
       RETURNING idempotency_record_id`,
      [
        input.actorId,
        input.operation,
        hexToBuffer(input.keyDigest),
        hexToBuffer(input.requestDigest),
        input.resourceRef ?? null,
      ],
    );
    if (inserted.rows.length > 0) {
      return {
        replayed: false,
        requestMatched: true,
        ...(input.resourceRef !== undefined ? { resourceRef: input.resourceRef } : {}),
      };
    }
    const existing = await this.db.query<IdempotencyRow>(
      `SELECT request_sha256, resource_id
         FROM public.idempotency_records
        WHERE actor_user_id = $1 AND operation = $2 AND key_sha256 = $3
        FOR UPDATE`,
      [input.actorId, input.operation, hexToBuffer(input.keyDigest)],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error('idempotency record disappeared after a conflict; database is inconsistent');
    }
    return {
      replayed: true,
      requestMatched: row.request_sha256.equals(hexToBuffer(input.requestDigest)),
      ...(row.resource_id !== null ? { resourceRef: row.resource_id } : {}),
    };
  }

  private async mark(
    input: { actorId: string; operation: string; keyDigest: string },
    recordState: 'accepted' | 'completed' | 'failed',
  ): Promise<void> {
    await this.db.query(
      `UPDATE public.idempotency_records
          SET record_state = $4
        WHERE actor_user_id = $1 AND operation = $2 AND key_sha256 = $3`,
      [input.actorId, input.operation, hexToBuffer(input.keyDigest), recordState],
    );
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
}
