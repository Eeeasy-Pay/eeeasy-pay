// Deterministic simulator of the sponsoring DFSP boundary. SIMULATOR ONLY.
// It moves no money, signs nothing, and invents no partner API details: every outcome is
// explicitly marked with SIMULATOR evidence (GUARDRAILS.md #2, #3; ADR-008). The real
// adapter is blocked on the signed scheme/partner profile (OPEN_DECISIONS.md B-01).

import type {
  Clock,
  QuoteRequest,
  QuoteOutcome,
  SponsorDfspPort,
  TransferCommand,
  TransferQueryOutcome,
  TransferSubmissionOutcome,
} from '@eeeasy-pay/ports';

export class StaticClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return new Date(this.at.getTime());
  }
  nowIso(): string {
    return this.at.toISOString();
  }
}

export type SimulatorScenario = 'success' | 'reject' | 'timeout_unknown';

export interface SimulatorOptions {
  /** Scripted scenario cycle, replayed in order. Defaults to ['success']. */
  readonly script?: readonly SimulatorScenario[];
  /** Quote validity in milliseconds. Default 60_000. */
  readonly quoteValidityMs?: number;
  /**
   * Deterministic flat fee in minor units. Default 1. This is a SIMULATOR placeholder,
   * NOT a fee schedule; real fees come from the partner profile (B-08).
   */
  readonly flatFeeMinor?: bigint;
}

interface SubmissionRecord {
  readonly scenario: SimulatorScenario;
  readonly occurredAt: string;
}

export class SimulatorSponsorDfspConnector implements SponsorDfspPort {
  private sequence = 0;
  private cursor = 0;
  private readonly script: readonly SimulatorScenario[];
  private readonly quoteValidityMs: number;
  private readonly flatFeeMinor: bigint;
  private readonly submissions = new Map<string, SubmissionRecord>();

  constructor(
    private readonly clock: Clock,
    options: SimulatorOptions = {},
  ) {
    this.script = options.script ?? ['success'];
    this.quoteValidityMs = options.quoteValidityMs ?? 60_000;
    this.flatFeeMinor = options.flatFeeMinor ?? 1n;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return prefix + '-' + String(this.sequence).padStart(6, '0');
  }

  private nextScenario(): SimulatorScenario {
    const scenario = this.script[this.cursor % this.script.length] ?? 'success';
    this.cursor += 1;
    return scenario;
  }

  async quote(request: QuoteRequest): Promise<QuoteOutcome> {
    if (request.requestedAmountMinor <= 0n) {
      throw new Error('simulator quote requires a positive minor-unit amount');
    }
    const issued = this.clock.now();
    const expires = new Date(issued.getTime() + this.quoteValidityMs);
    const fee = this.flatFeeMinor;
    return {
      providerKey: 'sim-dfsp',
      partnerQuoteRef: this.nextId('SQ'),
      apiProfile: 'SIMULATOR',
      currency: request.currency,
      requestedAmountMinor: request.requestedAmountMinor,
      quotedFeeMinor: fee,
      payerDebitMinor: request.requestedAmountMinor + fee,
      recipientAmountMinor: request.requestedAmountMinor,
      feeRuleVersion: 'simulator-flat-' + fee.toString(),
      issuedAt: issued.toISOString(),
      expiresAt: expires.toISOString(),
    };
  }

  async submitTransfer(command: TransferCommand): Promise<TransferSubmissionOutcome> {
    void command; // terms are bound upstream by the quote digest; the simulator does not re-verify
    const scenario = this.nextScenario();
    const externalTransferId = this.nextId('STX');
    const occurredAt = this.clock.nowIso();
    this.submissions.set(externalTransferId, { scenario, occurredAt });
    if (scenario === 'reject') {
      return {
        kind: 'rejected',
        externalTransferId,
        reasonCode: 'simulator_rejected',
        occurredAt,
      };
    }
    if (scenario === 'timeout_unknown') {
      // The submission MIGHT have been committed. Callers must reconcile via
      // queryTransfer(externalTransferId); they must never resubmit with a new id (ADR-006).
      return { kind: 'timeout_unknown', externalTransferId, occurredAt };
    }
    return {
      kind: 'committed',
      externalTransferId,
      evidenceSource: 'SIMULATOR',
      evidenceRef: 'sim-evidence-' + externalTransferId,
      occurredAt,
    };
  }

  async queryTransfer(externalTransferId: string): Promise<TransferQueryOutcome> {
    const record = this.submissions.get(externalTransferId);
    if (!record) {
      return { externalTransferId, status: 'unknown', occurredAt: this.clock.nowIso() };
    }
    if (record.scenario === 'reject') {
      return { externalTransferId, status: 'rejected', occurredAt: record.occurredAt };
    }
    // resolveUnknownAsCommitted: the simulator deterministically resolves ambiguous
    // submissions as committed so reconciliation demos end deterministically. Real
    // reconciliation follows the partner contract (B-01); this is NOT evidence of anything.
    return {
      externalTransferId,
      status: 'committed',
      evidenceSource: 'SIMULATOR',
      evidenceRef: 'sim-evidence-' + externalTransferId,
      occurredAt: record.occurredAt,
    };
  }
}
