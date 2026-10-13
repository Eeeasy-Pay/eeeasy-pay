// TICKET-006 scenario acceptance tests. Every fixture runs the real route handlers over
// loopback HTTP with the real TICKET-005 outbox worker and the deterministic simulator,
// and asserts the exact product-facing label journey. SIMULATOR ONLY: no bank debit,
// scheme transfer, or settlement occurred (GUARDRAILS.md #2, #3; OPEN_DECISIONS.md B-01).
import { describe, expect, it } from 'vitest';
import { runScenario, SCENARIO_NAMES } from './scenarios.ts';

const SIMULATOR_NOTE = 'simulated only: no bank debit, scheme transfer, or settlement occurred';

type ScenarioResult = Awaited<ReturnType<typeof runScenario>>;

function labelsOf(result: ScenarioResult): string[] {
  return result.transcript.map((step) => step.status.statusLabel);
}

describe('apps/api simulator scenarios (TICKET-006)', () => {
  it('exposes exactly the five ticket scenarios', () => {
    expect([...SCENARIO_NAMES]).toEqual([
      'success',
      'rejection',
      'expiry',
      'duplicate_request',
      'ambiguous_timeout_reconciliation',
    ]);
  });

  it('success: submitted -> processing -> recipient_credited_simulated -> settlement_simulated', async () => {
    const result = await runScenario('success');
    expect(labelsOf(result)).toEqual([
      'submitted',
      'processing',
      'recipient_credited_simulated',
      'recipient_credited_simulated',
      'settlement_simulated',
    ]);
    expect(result.transcript[2]?.status.state).toBe('completed');
    // The settlement dimension is SEPARATE: completion alone does not imply settlement.
    expect(result.transcript[2]?.status.settlementState).toBe('not_applicable');
    expect(result.transcript[3]?.status.settlementState).toBe('pending');
    expect(result.transcript[4]?.status.settlementState).toBe('settled');
    expect(result.externalSubmissions).toHaveLength(1);
    expect(result.externalSubmissions[0]?.kind).toBe('committed');
    expect(result.externalSubmissions[0]?.externalTransferId).toMatch(/^SCN-\d{6}$/);
    expect(result.outboxCommandCount).toBe(1);
    expect(result.submissionEventCount).toBe(1);
    expect(result.reconciliationEventCount).toBe(0);
    expect(result.reconciliationQueries).toHaveLength(0);
    for (const step of result.transcript) {
      expect(step.status.simulatorNote).toBe(SIMULATOR_NOTE);
      expect(step.status.paymentIntentId).toBe(result.paymentIntentId);
    }
  });

  it('rejection: the simulator refusal projects to the rejected label', async () => {
    const result = await runScenario('rejection');
    expect(labelsOf(result)).toEqual(['submitted', 'processing', 'rejected']);
    expect(result.transcript[2]?.status.state).toBe('rejected');
    expect(result.externalSubmissions).toHaveLength(1);
    expect(result.externalSubmissions[0]?.kind).toBe('rejected');
    expect(result.submissionEventCount).toBe(1);
    expect(result.reconciliationEventCount).toBe(0);
  });

  it('expiry: command-time refusal, read-only status, then the expired projection', async () => {
    const result = await runScenario('expiry');
    expect(labelsOf(result)).toEqual(['submitted', 'submitted', 'expired']);
    expect(result.transcript[1]?.httpStatus).toBe(409);
    // ADR-007: the refused confirm never mutated the row (status read stayed read-only).
    expect(result.transcript[1]?.status.state).toBe('quoted');
    expect(result.transcript[2]?.status.state).toBe('expired');
    expect(result.outboxCommandCount).toBe(0);
    expect(result.externalSubmissions).toHaveLength(0);
    expect(result.submissionEventCount).toBe(0);
  });

  it('duplicate request: one intent, one command, one submission', async () => {
    const result = await runScenario('duplicate_request');
    expect(labelsOf(result)).toEqual([
      'submitted',
      'submitted',
      'submitted',
      'processing',
      'processing',
      'recipient_credited_simulated',
    ]);
    expect(result.transcript[1]?.step).toBe('replayed');
    expect(result.transcript[2]?.httpStatus).toBe(409); // idempotency_conflict
    expect(result.transcript[4]?.httpStatus).toBe(409); // duplicate confirm: state_conflict
    expect(result.transcript[5]?.workerBatch?.published).toBe(1);
    expect(result.outboxCommandCount).toBe(1);
    expect(result.externalSubmissions).toHaveLength(1);
    expect(result.submissionEventCount).toBe(1);
    expect(result.reconciliationEventCount).toBe(0);
  });

  it('ambiguous timeout: reconciliation of the ORIGINAL id, never a resubmit', async () => {
    const result = await runScenario('ambiguous_timeout_reconciliation');
    expect(labelsOf(result)).toEqual([
      'submitted',
      'processing',
      'unknown_needs_reconciliation',
      'recipient_credited_simulated',
    ]);
    expect(result.transcript[2]?.status.state).toBe('unknown_reconciliation');
    expect(result.transcript[2]?.workerBatch?.pendingRetry).toBe(1);
    expect(result.transcript[2]?.workerBatch?.published).toBe(0);
    expect(result.transcript[3]?.status.state).toBe('completed');
    expect(result.transcript[3]?.workerBatch?.published).toBe(1);
    expect(result.externalSubmissions).toHaveLength(1);
    expect(result.externalSubmissions[0]?.kind).toBe('timeout_unknown');
    const externalId = result.externalSubmissions[0]?.externalTransferId;
    expect(externalId).toMatch(/^SCN-\d{6}$/);
    expect(result.reconciliationQueries).toEqual([externalId]);
    expect(result.submissionEventCount).toBe(1);
    expect(result.reconciliationEventCount).toBe(1);
    expect(result.outboxCommandCount).toBe(1);
  });
});
