import { describe, expect, it } from 'vitest';
import type { CompletionEvidence } from './state.ts';
import {
  EvidenceError,
  StateError,
  assertCompletable,
  assertTransition,
  isTerminal,
} from './state.ts';

const simEvidence = (overrides: Partial<CompletionEvidence> = {}): CompletionEvidence => ({
  source: 'SIMULATOR',
  recipientCreditState: 'credited',
  reference: 'sim-ref-1',
  recordedAt: '2026-10-08T00:00:00.000Z',
  ...overrides,
});

describe('transition legality', () => {
  it('allows the happy path', () => {
    const path = ['created', 'quoting', 'quoted', 'user_authorized', 'transfer_submitted'] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(() => assertTransition(path[i - 1]!, path[i]!)).not.toThrow();
    }
  });
  it('rejects skipped and illegal transitions', () => {
    expect(() => assertTransition('created', 'completed')).toThrow(StateError);
    expect(() => assertTransition('quoted', 'transfer_committed')).toThrow(StateError);
    expect(() => assertTransition('rejected', 'created')).toThrow(StateError);
  });
  it('treats terminal states as final', () => {
    for (const terminal of ['completed', 'rejected', 'expired', 'manual_resolution'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      expect(() => assertTransition(terminal, 'created')).toThrow(StateError);
    }
  });
  it('routes ambiguity into reconciliation, not blind retries', () => {
    expect(() => assertTransition('transfer_submitted', 'unknown_reconciliation')).not.toThrow();
    expect(() => assertTransition('unknown_reconciliation', 'completed')).not.toThrow();
  });
});

describe('completion evidence gate', () => {
  it('accepts SIMULATOR evidence with credited recipient credit for completed', () => {
    expect(() => assertCompletable('completed', simEvidence())).not.toThrow();
  });
  it('rejects completed without credited evidence', () => {
    expect(() =>
      assertCompletable('completed', simEvidence({ recipientCreditState: 'pending' })),
    ).toThrow(EvidenceError);
  });
  it('rejects credited evidence recorded outside completed', () => {
    expect(() => assertCompletable('transfer_committed', simEvidence())).toThrow(EvidenceError);
  });
  it('rejects PARTNER evidence in this simulator-only repository', () => {
    expect(() => assertCompletable('completed', simEvidence({ source: 'PARTNER' }))).toThrow(
      EvidenceError,
    );
  });
});
