// Product-side payment state machine (draft). It mirrors the reviewed payment_state enum in
// migration 202610060002 and encodes PRODUCT-side transition legality ONLY: it is not bank,
// DFSP, or scheme authority, and no transition here implies funds movement (GUARDRAILS.md #3).

export const PAYMENT_STATES = [
  'created',
  'lookup_pending',
  'quoting',
  'quoted',
  'user_authorized',
  'transfer_submitted',
  'transfer_processing',
  'transfer_prepared',
  'transfer_committed',
  'recipient_credit_pending',
  'completed',
  'rejected',
  'expired',
  'unknown_reconciliation',
  'compensation_pending',
  'manual_resolution',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'completed',
  'rejected',
  'expired',
  'manual_resolution',
]);

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

// Draft transition table. Review against the partner profile before any production claim (B-01).
const TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  created: ['lookup_pending', 'quoting', 'expired', 'rejected'],
  lookup_pending: ['quoting', 'rejected', 'expired'],
  quoting: ['quoted', 'rejected', 'expired'],
  quoted: ['user_authorized', 'expired', 'rejected'],
  user_authorized: ['transfer_submitted', 'rejected', 'expired'],
  transfer_submitted: ['transfer_processing', 'unknown_reconciliation', 'rejected'],
  transfer_processing: ['transfer_prepared', 'unknown_reconciliation', 'rejected'],
  transfer_prepared: ['transfer_committed', 'unknown_reconciliation', 'rejected'],
  transfer_committed: ['recipient_credit_pending', 'completed', 'unknown_reconciliation'],
  recipient_credit_pending: ['completed', 'unknown_reconciliation'],
  unknown_reconciliation: ['transfer_processing', 'completed', 'rejected', 'compensation_pending', 'manual_resolution'],
  compensation_pending: ['completed', 'rejected', 'manual_resolution'],
  completed: [],
  rejected: [],
  expired: [],
  manual_resolution: [],
};

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_PAYMENT_STATES.has(state);
}

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Throws unless the transition is legal. Terminal states never transition again. */
export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (isTerminal(from)) {
    throw new StateError('terminal payment state ' + from + ' cannot transition');
  }
  if (!canTransition(from, to)) {
    throw new StateError('illegal transition ' + from + ' -> ' + to);
  }
}

export type EvidenceSource = 'SIMULATOR' | 'PARTNER';

/**
 * Completion evidence is an explicit, separately-tracked dimension. It must never be
 * derived from a quote, HTTP response, local row, callback receipt, or push notification.
 */
export interface CompletionEvidence {
  readonly source: EvidenceSource;
  readonly recipientCreditState: 'credited' | 'pending' | 'not_credited';
  readonly reference: string;
  readonly recordedAt: string;
}

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/**
 * Completion gate: mirrors the DB CHECK (payment_state <> 'completed' OR
 * recipient_credit_state = 'credited'). In this simulator-only repository, only SIMULATOR
 * evidence may be recorded; PARTNER evidence requires the real sponsor connector (B-01).
 */
export function assertCompletable(state: PaymentState, evidence: CompletionEvidence): void {
  if (evidence.source === 'PARTNER') {
    throw new EvidenceError(
      'PARTNER completion evidence cannot be produced in this simulator-only repository (OPEN_DECISIONS.md B-01)',
    );
  }
  if (state === 'completed' && evidence.recipientCreditState !== 'credited') {
    throw new EvidenceError('completed state requires credited recipient-credit evidence');
  }
  if (state !== 'completed' && evidence.recipientCreditState === 'credited') {
    throw new EvidenceError('credited recipient-credit evidence recorded outside the completed state');
  }
}
