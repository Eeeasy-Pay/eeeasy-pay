import type { Pool } from 'pg';
import { Db } from './db.ts';
import { PostgresIdempotencyRepository } from './idempotency-repository.ts';
import { PostgresInboxRepository } from './inbox-repository.ts';
import { PostgresOutboxRepository } from './outbox-repository.ts';
import { PostgresPaymentCommands } from './confirm-command.ts';
import { PostgresPaymentEventRepository } from './event-repository.ts';
import { PostgresPaymentIntentRepository } from './intent-repository.ts';
import { PostgresQuoteRepository } from './quote-repository.ts';
import { PostgresSplitInviteClaim } from './split-claim.ts';
import { PostgresTransactionBoundary } from './transaction.ts';

export interface PersistenceStores {
  readonly db: Db;
  readonly transactions: PostgresTransactionBoundary;
  readonly intents: PostgresPaymentIntentRepository;
  readonly quotes: PostgresQuoteRepository;
  readonly idempotency: PostgresIdempotencyRepository;
  readonly events: PostgresPaymentEventRepository;
  readonly outbox: PostgresOutboxRepository;
  readonly inbox: PostgresInboxRepository;
  readonly commands: PostgresPaymentCommands;
  readonly split: PostgresSplitInviteClaim;
}

/**
 * Wires all repositories over one pool and one transaction boundary so a command and its
 * outbox enqueue can share a transaction: run `transactions.run(() => ...)` and every
 * repository call inside joins that transaction.
 */
export function createPersistenceStores(pool: Pool): PersistenceStores {
  const transactions = new PostgresTransactionBoundary(pool);
  const db = new Db(pool, () => transactions.currentClient());
  return {
    db,
    transactions,
    intents: new PostgresPaymentIntentRepository(db),
    quotes: new PostgresQuoteRepository(db),
    idempotency: new PostgresIdempotencyRepository(db),
    events: new PostgresPaymentEventRepository(db),
    outbox: new PostgresOutboxRepository(db),
    inbox: new PostgresInboxRepository(db),
    commands: new PostgresPaymentCommands(db),
    split: new PostgresSplitInviteClaim(db),
  };
}
