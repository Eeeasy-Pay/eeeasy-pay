// @eeeasy-pay/persistence — narrow Postgres repositories and transaction boundaries over
// the reviewed migrations (supabase/migrations). Implemented in TICKET-004.
//
// Binding constraints (do not change without a new ADR):
// - Command + idempotency + event + outbox enqueue commit in ONE transaction (ADR-006).
// - No repository bypasses the RLS/grant model of the migrations; service_role stays
//   server-side and is never exposed to the mobile app (GUARDRAILS.md #5).
// - Append-only tables (payment_events, journal_entries) are never updated or deleted.
// - bigint is parsed as JS bigint everywhere; digests are hex strings at the port
//   boundary and bytea in storage; no funds movement is implied by any write
//   (GUARDRAILS.md #2, #3).

export { createPersistenceSql, hexToBuffer, toHex, type DbLike, type Sql } from './client.ts';
export { PostgresTransactions } from './transactions.ts';
export {
  PostgresIdempotencyRepository,
} from './idempotency.ts';
export {
  PostgresPaymentIntentRepository,
  type ConfirmIntentInput,
  type ConfirmIntentResult,
  type CreateIntentWithQuoteInput,
  type PaymentEventInput,
  type QuoteTermsInput,
  type StoredQuote,
} from './intents.ts';
export { PostgresOutboxRepository } from './outbox.ts';
export { PostgresInboxRepository } from './inbox.ts';
export {
  PostgresSplitRepository,
  type CreateSplitBillInput,
  type SplitShareDraft,
  type StoredSplitBill,
  type StoredSplitShare,
} from './splits.ts';
export {
  PostgresJournalRepository,
  type JournalLine,
  type PostJournalInput,
} from './journal.ts';
