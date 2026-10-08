// Worker placeholder. Restart-safe outbox processing is implemented in TICKET-005
// (docs/implementation/TICKETS.md).

export const WORKER_TICKET = 'TICKET-005' as const;

/**
 * Invariants the implementation must preserve (ADR-006, GUARDRAILS.md #2, #4):
 */
export const WORKER_INVARIANTS = [
  'processes only durable outbox commands claimed through lease-based claiming',
  'safe after crash/restart: expired leases return messages to pending, no duplicate effects',
  'timeout_unknown outcomes are reconciled by querying the ORIGINAL external id; never resubmit with a new id',
  'inbox events deduplicated by (provider key, provider event id) + payload digest; a changed payload under the same event id is quarantined',
  'no direct production partner connection: simulator only, all evidence marked SIMULATOR',
  'settlement evidence stays a separate dimension and is never implied by a submission ack',
] as const;
