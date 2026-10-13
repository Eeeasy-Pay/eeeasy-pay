// Transaction boundary over postgres.js (ADR-006): a command, its idempotency record,
// its append-only event and its outbox enqueue commit in ONE database transaction.
//
// Scope rule: one PostgresTransactions instance belongs to one request/worker scope.
// Overlapping run() calls on the same instance join the FIRST open transaction; it
// is not a re-entrant saga coordinator. The PAL wires one instance per command scope.

import type { TransactionBoundary } from '@eeeasy-pay/ports';
import type { DbLike, Sql } from './client.ts';

export class PostgresTransactions implements TransactionBoundary {
  private readonly sql: Sql;
  private current: DbLike | undefined;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** The client repositories must use so they participate in the ambient transaction. */
  client(): DbLike {
    return this.current ?? this.sql;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.current) {
      // Nested run() joins the already-open transaction: command + idempotency +
      // event + outbox stay atomic even when orchestration spans several repos.
      return operation();
    }
    return this.sql.begin(async (tx) => {
      this.current = tx as unknown as DbLike;
      try {
        return await operation();
      } finally {
        this.current = undefined;
      }
    });
  }
}
