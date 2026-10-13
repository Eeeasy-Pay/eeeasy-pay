// Restart-safe outbox processing and inbox projection (TICKET-005). Simulator-only: the
// only SponsorDfspPort implementation in this repository is the deterministic simulator
// (OPEN_DECISIONS.md B-01), and nothing here moves money or implies settlement
// (GUARDRAILS.md #2, #3).

export {
  OutboxWorker,
  parseSubmitPaymentPayload,
  SUBMIT_PAYMENT_COMMAND,
  type BatchResult,
  type OutboxWorkerDeps,
  type OutboxWorkerOptions,
  type SubmitPaymentPayload,
  type WorkerEventStore,
} from './processor.ts';
export {
  InboxIngestor,
  type InboxIngestDeps,
  type InboxIngestInput,
  type InboxIngestResult,
  type WorkerInboxStore,
} from './inbox.ts';

/**
 * Invariants the implementation preserves (ADR-006, GUARDRAILS.md #2, #4):
 */
export const WORKER_INVARIANTS = [
  'processes only durable outbox commands claimed through lease-based claiming',
  'safe after crash/restart: expired leases return messages to pending, no duplicate effects',
  'timeout_unknown outcomes are reconciled by querying the ORIGINAL external id; never resubmit with a new id',
  'inbox events deduplicated by (provider key, provider event id) + payload digest; a changed payload under the same event id is quarantined',
  'no direct production partner connection: simulator only, all evidence marked SIMULATOR',
  'settlement evidence stays a separate dimension and is never implied by a submission ack',
] as const;
