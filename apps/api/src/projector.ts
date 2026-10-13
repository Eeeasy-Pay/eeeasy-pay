// Scenario projection (TICKET-006): folds the append-only worker evidence recorded by
// apps/worker (TICKET-005) into the in-memory intent projection, walking only LEGAL
// domain transitions. SIMULATOR ONLY: the completion evidence source is always the
// deterministic simulator, the settlement dimension is staged separately, and nothing
// here implies bank credit or settlement (GUARDRAILS.md #2, #3; OPEN_DECISIONS.md B-01).
//
// Read-only guarantees are preserved (ADR-007): GET handlers never mutate. The elapsed
// quote expiry projection below is a scenario-side projection step, and command-time
// enforcement (confirm refuses elapsed quotes with 409 quote_expired) remains the guard
// in app.ts.

import { assertCompletable, assertTransition } from '@eeeasy-pay/domain';
import type { CompletionEvidence, PaymentState } from '@eeeasy-pay/domain';
import { projectQuoteStatus } from '@eeeasy-pay/pal';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import type { Clock } from '@eeeasy-pay/ports';
import type {
  MemoryIntentStore,
  MemoryPaymentEventRecord,
  MemoryPaymentEventStore,
  MemoryQuoteStore,
} from './memory.ts';

/** A recorded external transfer submission for one payment intent. */
export interface SubmissionFact {
  readonly outcome: 'committed' | 'rejected' | 'timeout_unknown';
  readonly externalTransferId: string;
  readonly occurredAt: string;
}

/** A completed reconciliation that resolved an ambiguous submission. */
export interface ReconciliationFact {
  readonly externalTransferId: string;
  readonly resolvedStatus: 'committed' | 'rejected';
  readonly evidenceRef: string | null;
  readonly occurredAt: string;
}

export interface ScenarioFacts {
  readonly submission: SubmissionFact | null;
  readonly reconciliation: ReconciliationFact | null;
}

function metadataOf(event: MemoryPaymentEventRecord): Record<string, unknown> {
  return event.safeMetadata as Record<string, unknown>;
}

/**
 * Reads the worker's submission and reconciliation evidence from the append-only log.
 * The log is chronological, so the last matching fact wins.
 */
export function readScenarioFacts(events: readonly MemoryPaymentEventRecord[]): ScenarioFacts {
  let submission: SubmissionFact | null = null;
  let reconciliation: ReconciliationFact | null = null;
  for (const event of events) {
    const metadata = metadataOf(event);
    if (
      event.eventType === WORKER_SUBMISSION_EVENT.eventType &&
      event.sourceSystem === WORKER_SUBMISSION_EVENT.sourceSystem
    ) {
      const externalTransferId = metadata['external_transfer_id'];
      const outcome = metadata['outcome'];
      if (
        typeof externalTransferId === 'string' &&
        (outcome === 'committed' || outcome === 'rejected' || outcome === 'timeout_unknown')
      ) {
        submission = {
          outcome,
          externalTransferId,
          occurredAt: event.occurredAt ?? '',
        };
      }
    }
    if (
      event.eventType === WORKER_RECONCILIATION_EVENT.eventType &&
      event.sourceSystem === WORKER_RECONCILIATION_EVENT.sourceSystem
    ) {
      const externalTransferId = metadata['external_transfer_id'];
      const queryStatus = metadata['query_status'];
      const evidenceRef = metadata['evidence_ref'];
      if (
        typeof externalTransferId === 'string' &&
        (queryStatus === 'committed' || queryStatus === 'rejected')
      ) {
        reconciliation = {
          externalTransferId,
          resolvedStatus: queryStatus,
          evidenceRef: typeof evidenceRef === 'string' ? evidenceRef : null,
          occurredAt: event.occurredAt ?? '',
        };
      }
    }
  }
  return { submission, reconciliation };
}

/**
 * The legal state path from the current state to the evidence-implied outcome, or null
 * when the evidence does not move this intent.
 */
function projectionPath(state: PaymentState, facts: ScenarioFacts): readonly PaymentState[] | null {
  if (facts.reconciliation !== null) {
    if (state === 'user_authorized') {
      // The projection step was skipped while the worker reconciled (e.g. a crash):
      // the ambiguous hop is still walked before the resolved outcome.
      return facts.reconciliation.resolvedStatus === 'committed'
        ? ['transfer_submitted', 'unknown_reconciliation', 'completed']
        : ['transfer_submitted', 'unknown_reconciliation', 'rejected'];
    }
    if (state === 'unknown_reconciliation') {
      return facts.reconciliation.resolvedStatus === 'committed' ? ['completed'] : ['rejected'];
    }
    return null;
  }
  if (facts.submission !== null && state === 'user_authorized') {
    switch (facts.submission.outcome) {
      case 'committed':
        return [
          'transfer_submitted',
          'transfer_processing',
          'transfer_prepared',
          'transfer_committed',
          'completed',
        ];
      case 'rejected':
        return ['transfer_submitted', 'rejected'];
      case 'timeout_unknown':
        return ['transfer_submitted', 'unknown_reconciliation'];
    }
  }
  return null;
}

export interface ProjectionChange {
  readonly paymentIntentId: string;
  readonly from: PaymentState;
  readonly to: PaymentState;
}

export interface ProjectorDeps {
  readonly clock: Clock;
  readonly intents: MemoryIntentStore;
  readonly quotes: MemoryQuoteStore;
  readonly events: MemoryPaymentEventStore;
}

/**
 * Projects ONE intent from its current state over its recorded evidence, walking only
 * legal domain transitions (each hop assertTransition-checked). Returns the applied
 * change, or null when there is nothing to project.
 */
export async function projectIntentState(
  deps: ProjectorDeps,
  paymentIntentId: string,
): Promise<ProjectionChange | null> {
  const record = deps.intents.peek(paymentIntentId);
  if (record === null) {
    return null;
  }
  const nowIso = deps.clock.nowIso();
  if (record.state === 'quoted') {
    const stored =
      record.currentQuoteId === undefined ? null : deps.quotes.findByQuoteId(record.currentQuoteId);
    if (
      stored !== null &&
      projectQuoteStatus(stored.quote.expiresAt, nowIso).quoteStatus === 'expired'
    ) {
      assertTransition('quoted', 'expired');
      deps.intents.put({ ...record, state: 'expired', updatedAt: nowIso });
      return { paymentIntentId, from: 'quoted', to: 'expired' };
    }
    return null;
  }
  if (record.state !== 'user_authorized' && record.state !== 'unknown_reconciliation') {
    return null;
  }
  const facts = readScenarioFacts(deps.events.listForIntent(paymentIntentId));
  const path = projectionPath(record.state, facts);
  if (path === null) {
    return null;
  }
  let state: PaymentState = record.state;
  for (const next of path) {
    assertTransition(state, next);
    state = next;
  }
  if (state === 'completed') {
    // Completion is gated on explicit SIMULATOR recipient-credit evidence
    // (assertCompletable, B-01); a submission ack alone NEVER completes a payment.
    const evidence: CompletionEvidence = {
      source: 'SIMULATOR',
      recipientCreditState: 'credited',
      reference: facts.reconciliation?.evidenceRef ?? facts.submission?.externalTransferId ?? '',
      recordedAt: facts.reconciliation?.occurredAt ?? facts.submission?.occurredAt ?? nowIso,
    };
    assertCompletable('completed', evidence);
  }
  deps.intents.put({ ...record, state, updatedAt: nowIso });
  return { paymentIntentId, from: record.state, to: state };
}

/**
 * Stages the EXPLICITLY simulated settlement dimension (TICKET-006). This stages a
 * separate evidence dimension as a fixture; no settlement occurred (GUARDRAILS.md #3,
 * B-01). Only a completed payment can be staged, and the stages move in order.
 */
export function applySimulatedSettlementStage(
  deps: Pick<ProjectorDeps, 'clock' | 'intents'>,
  paymentIntentId: string,
  stage: 'pending' | 'settled',
): void {
  const record = deps.intents.peek(paymentIntentId);
  if (record === null) {
    throw new Error('payment intent not found for the simulated settlement stage');
  }
  if (record.state !== 'completed') {
    throw new Error('the simulated settlement stage requires a completed payment');
  }
  if (stage === 'pending' && record.settlementState !== undefined) {
    throw new Error('the simulated settlement stage is already pending');
  }
  if (stage === 'settled' && record.settlementState !== 'pending') {
    throw new Error('settlement must be staged pending before settled');
  }
  deps.intents.put({ ...record, settlementState: stage, updatedAt: deps.clock.nowIso() });
}
