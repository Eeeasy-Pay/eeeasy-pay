// Product HTTP API placeholder. Routes are implemented in TICKET-003
// (docs/implementation/TICKETS.md).

export const API_TICKET = 'TICKET-003' as const;

/** Product-side routes only (GUARDRAILS.md #7). No Mojaloop endpoint is ever exposed. */
export const API_ROUTES = [
  'POST /v1/payment-intents',
  'GET /v1/payment-intents/{id}',
  'POST /v1/payment-intents/{id}/confirm',
  'GET /v1/payment-intents/{id}/status',
  'POST /v1/split-bills',
  'GET /v1/split-bills/{id}',
  'POST /v1/split-shares/{id}/claim-invite',
] as const;

/**
 * Binding rules for the implementation:
 * - POST /confirm returns 202 Accepted once the durable authorization transaction
 *   (idempotency + event + outbox command) is committed; processing continues in the worker.
 * - Errors use the closed problem-code set with a correlation id (packages/contracts).
 * - GET is a read-only projection; quoteStatus/canConfirm project elapsed quotes WITHOUT
 *   mutating any row (ADR-007).
 * - Server-scoped idempotency: actor + operation + canonical request fingerprint (ADR-005).
 *   Same key + same request -> replay the prior result; same key + different request ->
 *   idempotency_conflict.
 * - Status responses distinguish submitted / processing / unknown_needs_reconciliation /
 *   recipient_credited_simulated / settlement_simulated and never label simulated
 *   evidence as a real transfer.
 */
export const API_INVARIANTS = [
  '202 Accepted for durable asynchronous work',
  'closed problem codes + correlation ids',
  'read-only GET projections',
  'never expose scheme/partner endpoints to the mobile client',
] as const;
