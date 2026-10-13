import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Narrow query surface over the pool with an ambient-transaction override: inside
 * PostgresTransactionBoundary.run() every query runs on the transaction's dedicated
 * client, so a command and its outbox enqueue commit together (ADR-006).
 */
export class Db {
  constructor(
    private readonly pool: Pool,
    private readonly ambientClient: () => PoolClient | undefined,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const client = this.ambientClient();
    if (client) {
      return client.query(sql, params);
    }
    return this.pool.query(sql, params);
  }
}
