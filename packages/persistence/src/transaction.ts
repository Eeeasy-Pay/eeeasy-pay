import { AsyncLocalStorage } from 'node:async_hooks';
import type { TransactionBoundary } from '@eeeasy-pay/ports';
import type { Pool, PoolClient } from 'pg';

/**
 * BEGIN/COMMIT/ROLLBACK on a dedicated pool client, exposed to repositories through
 * AsyncLocalStorage so every query inside run() joins the same transaction without
 * threading a client through the call stack (ADR-006). Nested transactions are rejected
 * rather than silently converted to savepoints.
 */
export class PostgresTransactionBoundary implements TransactionBoundary {
  private readonly storage = new AsyncLocalStorage<PoolClient>();

  constructor(private readonly pool: Pool) {}

  /** The client of the innermost active transaction, if any. */
  currentClient(): PoolClient | undefined {
    return this.storage.getStore();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.storage.getStore()) {
      throw new Error('nested transactions are not supported by PostgresTransactionBoundary');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.storage.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already unusable; the original error is the useful one.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
