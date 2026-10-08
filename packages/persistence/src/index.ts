// Placeholder package. The narrow Postgres repositories and transaction boundaries over
// the reviewed migrations (supabase/migrations) are implemented in TICKET-004
// (docs/implementation/TICKETS.md).
//
// Constraints for the implementation (already decided, do not change without a new ADR):
// - Command + idempotency + event + outbox enqueue commit in ONE transaction (ADR-006).
// - No repository may bypass the RLS/grant model of the migrations; service_role stays
//   server-side and is never exposed to the mobile app (GUARDRAILS.md #5).
// - Append-only tables (payment_events, journal_entries) are never updated or deleted.

export const PERSISTENCE_TICKET = 'TICKET-004' as const;
