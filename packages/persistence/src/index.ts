// Narrow Postgres repositories and transaction boundaries over the reviewed migrations
// (TICKET-004, docs/implementation/TICKETS.md).
//
// Constraints (already decided, do not change without a new ADR):
// - Command + idempotency + event + outbox enqueue commit in ONE transaction (ADR-006).
// - No repository may bypass the RLS/grant model of the migrations: privileged writes go
//   through the reviewed app_private functions; service_role stays server-side and is
//   never exposed to the mobile app (GUARDRAILS.md #5).
// - Append-only tables (payment_events, journal_entries) are never updated or deleted.

export { Db } from './db.ts';
export { mapDbError, mapDbErrorAsync } from './errors.ts';
export { bufferToHex, hexToBuffer } from './hex.ts';
export { PostgresTransactionBoundary } from './transaction.ts';
export {
  PostgresPaymentIntentRepository,
  type PaymentIntentCreateInput,
  type PaymentIntentWriter,
} from './intent-repository.ts';
export { PostgresQuoteRepository } from './quote-repository.ts';
export { PostgresIdempotencyRepository } from './idempotency-repository.ts';
export { PostgresPaymentEventRepository } from './event-repository.ts';
export { PostgresOutboxRepository, mapOutboxRow, type OutboxRow } from './outbox-repository.ts';
export { PostgresInboxRepository } from './inbox-repository.ts';
export { PostgresPaymentCommands } from './confirm-command.ts';
export { PostgresSplitInviteClaim } from './split-claim.ts';
export { createPersistenceStores, type PersistenceStores } from './stores.ts';
