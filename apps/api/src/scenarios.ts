// Deterministic end-to-end demo fixtures (TICKET-006). SIMULATOR ONLY: the sponsor port
// is the deterministic simulator, every outcome carries SIMULATOR evidence, and the
// settlement stage is an explicitly simulated dimension — no bank debit, scheme
// transfer, or settlement ever occurred (GUARDRAILS.md #2, #3; OPEN_DECISIONS.md B-01).
//
// Every scenario drives the REAL route handlers over loopback HTTP, the REAL TICKET-005
// OutboxWorker, and the scenario projection (projector.ts), then records a transcript
// of status snapshots so the TICKET-007 demo and the tests assert the exact
// product-facing label journey: submitted -> processing -> [unknown_needs_reconciliation
// ->] recipient_credited_simulated -> settlement_simulated.

import { Buffer } from 'node:buffer';
import {
  PaymentIntentV1Schema,
  PaymentStatusV1Schema,
  ProblemDetailSchema,
} from '@eeeasy-pay/contracts';
import type { PaymentStatusV1 } from '@eeeasy-pay/contracts';
import { WORKER_RECONCILIATION_EVENT, WORKER_SUBMISSION_EVENT } from '@eeeasy-pay/ports';
import type {
  Clock,
  QuoteOutcome,
  QuoteRequest,
  SponsorDfspPort,
  TransferCommand,
  TransferQueryOutcome,
  TransferSubmissionOutcome,
  UuidGenerator,
} from '@eeeasy-pay/ports';
import { SimulatorSponsorDfspConnector } from '@eeeasy-pay/sponsor-dfsp-connector';
import type { SimulatorScenario } from '@eeeasy-pay/sponsor-dfsp-connector';
import { OutboxWorker } from '@eeeasy-pay/worker';
import type { BatchResult } from '@eeeasy-pay/worker';
import { createApiApp } from './app.ts';
import {
  MemoryIdempotencyRepository,
  MemoryIntentStore,
  MemoryOutboxRepository,
  MemoryPaymentEventStore,
  MemoryQuoteStore,
  MemoryTransaction,
} from './memory.ts';
import { applySimulatedSettlementStage, projectIntentState } from './projector.ts';
import type { ProjectorDeps } from './projector.ts';

const START_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
const DEMO_ACTOR = 'demo-scenario-actor';
const DEFAULT_QUOTE_VALIDITY_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 1_000;

const SCENARIO_CREATE_BODY = {
  sourceBankLinkId: '11111111-1111-4111-8111-111111111111',
  recipientAliasId: 'alias-7',
  currency: 'SDG',
  amountMinor: '1000',
} as const;

export const SCENARIO_NAMES = [
  'success',
  'rejection',
  'expiry',
  'duplicate_request',
  'ambiguous_timeout_reconciliation',
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export interface ScenarioOptions {
  /** Quote validity window; must stay well above the scenario duration. Default 60s. */
  readonly quoteValidityMs?: number;
  /** Worker retry backoff for the ambiguous-timeout reconciliation. Default 1s. */
  readonly retryBackoffMs?: number;
}

export interface ScenarioStep {
  /** Stable machine-readable step id. */
  readonly step: string;
  /** Human-readable description for the demo transcript (TICKET-007). */
  readonly description: string;
  readonly status: PaymentStatusV1;
  /** HTTP status of the command that triggered this step, when one did. */
  readonly httpStatus?: number;
  /** The worker batch result, when the step ran the outbox worker. */
  readonly workerBatch?: BatchResult;
}

export interface ExternalSubmissionCall {
  readonly kind: 'committed' | 'rejected' | 'timeout_unknown';
  readonly externalTransferId: string | null;
}

export interface ScenarioRunResult {
  readonly scenario: ScenarioName;
  readonly paymentIntentId: string;
  readonly transcript: readonly ScenarioStep[];
  /** Every external submitTransfer the scenario issued (the simulator's evidence). */
  readonly externalSubmissions: readonly ExternalSubmissionCall[];
  /** Every queryTransfer the worker issued (reconciliation of the ORIGINAL id). */
  readonly reconciliationQueries: readonly string[];
  /** Durable outbox commands enqueued by the confirm command. */
  readonly outboxCommandCount: number;
  readonly submissionEventCount: number;
  readonly reconciliationEventCount: number;
}

class MutableClock implements Clock {
  private atMs: number;

  constructor(atMs: number = START_MS) {
    this.atMs = atMs;
  }

  now(): Date {
    return new Date(this.atMs);
  }

  nowIso(): string {
    return new Date(this.atMs).toISOString();
  }

  advance(ms: number): void {
    this.atMs += ms;
  }
}

class SequentialUuid implements UuidGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return '00000000-0000-4000-8000-' + String(this.counter).padStart(12, '0');
  }
}

/** Unsigned JWT-shaped token, mirroring the structure-only simulator auth (B-01). */
function bearerToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return header + '.' + payload + '.';
}

/** Counts every sponsor call so scenarios can prove single-submission invariants. */
class CountingSponsorDfspConnector implements SponsorDfspPort {
  readonly submissionOutcomes: ExternalSubmissionCall[] = [];
  readonly queryExternalIds: string[] = [];

  constructor(private readonly inner: SponsorDfspPort) {}

  async quote(request: QuoteRequest): Promise<QuoteOutcome> {
    return this.inner.quote(request);
  }

  async submitTransfer(command: TransferCommand): Promise<TransferSubmissionOutcome> {
    const outcome = await this.inner.submitTransfer(command);
    const externalTransferId = outcome.externalTransferId;
    this.submissionOutcomes.push({
      kind: outcome.kind,
      externalTransferId: externalTransferId === undefined ? null : externalTransferId,
    });
    return outcome;
  }

  async queryTransfer(externalTransferId: string): Promise<TransferQueryOutcome> {
    const outcome = await this.inner.queryTransfer(externalTransferId);
    this.queryExternalIds.push(externalTransferId);
    return outcome;
  }
}

export interface ScenarioHarness {
  readonly clock: MutableClock;
  readonly intents: MemoryIntentStore;
  readonly quotes: MemoryQuoteStore;
  readonly outbox: MemoryOutboxRepository;
  readonly events: MemoryPaymentEventStore;
  readonly sponsorLog: CountingSponsorDfspConnector;
  readonly worker: OutboxWorker;
  call(method: string, path: string, options?: { readonly body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly script: readonly SimulatorScenario[];
  readonly quoteValidityMs: number;
  readonly retryBackoffMs: number;
}

async function startHarness(options: HarnessOptions): Promise<ScenarioHarness> {
  const clock = new MutableClock();
  const uuid = new SequentialUuid();
  const sponsor = new CountingSponsorDfspConnector(
    new SimulatorSponsorDfspConnector(clock, {
      script: options.script,
      quoteValidityMs: options.quoteValidityMs,
      flatFeeMinor: 1n,
      idPrefix: 'SCN',
    }),
  );
  const intents = new MemoryIntentStore();
  const quotes = new MemoryQuoteStore();
  const idempotency = new MemoryIdempotencyRepository();
  const outbox = new MemoryOutboxRepository(uuid, clock);
  const events = new MemoryPaymentEventStore(uuid);
  const tx = new MemoryTransaction();
  const worker = new OutboxWorker(
    { outbox, events, sponsor, clock, workerId: 'scenario-worker' },
    { claimLimit: 5, leaseSeconds: 30, retryBackoffMs: [options.retryBackoffMs], maxAttempts: 3 },
  );
  const server = createApiApp({ clock, uuid, sponsor, intents, quotes, idempotency, outbox, tx });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a tcp server address');
  }
  const baseUrl = 'http://127.0.0.1:' + String(address.port);
  const token = bearerToken(DEMO_ACTOR);
  const call = (
    method: string,
    path: string,
    options?: { readonly body?: unknown },
  ): Promise<Response> => {
    const headers: Record<string, string> = { authorization: 'Bearer ' + token };
    if (options?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const init: RequestInit = { method, headers };
    if (options?.body !== undefined) {
      init.body = JSON.stringify(options.body);
    }
    return fetch(baseUrl + path, init);
  };
  const close = async (): Promise<void> => {
    // Destroy idle keep-alive sockets so close() resolves deterministically.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
  return { clock, intents, quotes, outbox, events, sponsorLog: sponsor, worker, call, close };
}

type Transcript = ScenarioStep[];

function projectorOf(harness: ScenarioHarness): ProjectorDeps {
  return {
    clock: harness.clock,
    intents: harness.intents,
    quotes: harness.quotes,
    events: harness.events,
  };
}

function confirmPath(paymentIntentId: string): string {
  return '/v1/payment-intents/' + paymentIntentId + '/confirm';
}

async function createScenarioIntent(
  harness: ScenarioHarness,
  options?: { readonly key?: string; readonly amountMinor?: string },
): Promise<string> {
  const body = {
    ...SCENARIO_CREATE_BODY,
    ...(options?.amountMinor !== undefined ? { amountMinor: options.amountMinor } : {}),
    ...(options?.key !== undefined ? { idempotencyKey: options.key } : {}),
  };
  const response = await harness.call('POST', '/v1/payment-intents', { body });
  if (response.status !== 201) {
    throw new Error('scenario create failed with HTTP ' + String(response.status));
  }
  const intent = PaymentIntentV1Schema.parse(await response.json());
  return intent.paymentIntentId;
}

async function snapshotStatus(
  harness: ScenarioHarness,
  paymentIntentId: string,
): Promise<PaymentStatusV1> {
  const response = await harness.call('GET', '/v1/payment-intents/' + paymentIntentId + '/status');
  if (response.status !== 200) {
    throw new Error('scenario status read failed with HTTP ' + String(response.status));
  }
  return PaymentStatusV1Schema.parse(await response.json());
}

async function recordStep(
  harness: ScenarioHarness,
  transcript: Transcript,
  paymentIntentId: string,
  step: string,
  description: string,
  extras?: { readonly httpStatus?: number; readonly workerBatch?: BatchResult },
): Promise<void> {
  const status = await snapshotStatus(harness, paymentIntentId);
  transcript.push({
    step,
    description,
    status,
    ...(extras?.httpStatus !== undefined ? { httpStatus: extras.httpStatus } : {}),
    ...(extras?.workerBatch !== undefined ? { workerBatch: extras.workerBatch } : {}),
  });
}

async function confirmScenarioIntent(
  harness: ScenarioHarness,
  paymentIntentId: string,
): Promise<void> {
  const response = await harness.call('POST', confirmPath(paymentIntentId));
  if (response.status !== 202) {
    throw new Error('scenario confirm failed with HTTP ' + String(response.status));
  }
}

async function expectProjected(
  harness: ScenarioHarness,
  paymentIntentId: string,
  to: 'completed' | 'rejected' | 'unknown_reconciliation' | 'expired',
): Promise<void> {
  const change = await projectIntentState(projectorOf(harness), paymentIntentId);
  if (change === null || change.to !== to) {
    throw new Error(
      'scenario projection expected ' + to + ' but got ' + (change === null ? 'null' : change.to),
    );
  }
}

async function runSuccessScenario(
  harness: ScenarioHarness,
  transcript: Transcript,
): Promise<string> {
  const paymentIntentId = await createScenarioIntent(harness);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'created',
    'payment intent created with a valid simulator quote (label: submitted)',
  );
  await confirmScenarioIntent(harness, paymentIntentId);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'confirmed',
    'confirm accepted with 202; one submit_payment outbox command enqueued (label: processing)',
    { httpStatus: 202 },
  );
  const batch = await harness.worker.runBatch();
  if (batch.claimed !== 1 || batch.published !== 1) {
    throw new Error(
      'success scenario expected exactly one published submission: ' + JSON.stringify(batch),
    );
  }
  await expectProjected(harness, paymentIntentId, 'completed');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'transfer_completed',
    'the worker submitted to the simulator and recorded SIMULATOR evidence; the projection completed the payment (label: recipient_credited_simulated)',
    { workerBatch: batch },
  );
  applySimulatedSettlementStage(
    { clock: harness.clock, intents: harness.intents },
    paymentIntentId,
    'pending',
  );
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'settlement_pending',
    'explicitly simulated settlement stage: pending (a separate evidence dimension; no settlement occurred)',
  );
  applySimulatedSettlementStage(
    { clock: harness.clock, intents: harness.intents },
    paymentIntentId,
    'settled',
  );
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'settlement_simulated',
    'explicitly simulated settlement stage: settled (label: settlement_simulated)',
  );
  return paymentIntentId;
}

async function runRejectionScenario(
  harness: ScenarioHarness,
  transcript: Transcript,
): Promise<string> {
  const paymentIntentId = await createScenarioIntent(harness);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'created',
    'payment intent created with a valid simulator quote (label: submitted)',
  );
  await confirmScenarioIntent(harness, paymentIntentId);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'confirmed',
    'confirm accepted with 202; the simulator is scripted to reject the transfer (label: processing)',
    { httpStatus: 202 },
  );
  const batch = await harness.worker.runBatch();
  if (batch.claimed !== 1 || batch.published !== 1) {
    throw new Error(
      'rejection scenario expected exactly one recorded rejection: ' + JSON.stringify(batch),
    );
  }
  await expectProjected(harness, paymentIntentId, 'rejected');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'transfer_rejected',
    'the simulator rejected the transfer with a simulator-only reason code; the projection rejected the payment (label: rejected)',
    { workerBatch: batch },
  );
  return paymentIntentId;
}

async function runExpiryScenario(
  harness: ScenarioHarness,
  transcript: Transcript,
  quoteValidityMs: number,
): Promise<string> {
  const paymentIntentId = await createScenarioIntent(harness);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'created',
    'payment intent created with a valid simulator quote (label: submitted)',
  );
  harness.clock.advance(quoteValidityMs + 1);
  const response = await harness.call('POST', confirmPath(paymentIntentId));
  if (response.status !== 409) {
    throw new Error(
      'expiry scenario expected the confirm to be refused with 409, got HTTP ' +
        String(response.status),
    );
  }
  const problem = ProblemDetailSchema.parse(await response.json());
  if (problem.code !== 'quote_expired') {
    throw new Error('expiry scenario expected quote_expired, got ' + problem.code);
  }
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'quote_elapsed',
    'the quote elapsed; confirm was refused at command time with 409 quote_expired while status reads stayed read-only (state unchanged: quoted)',
    { httpStatus: 409 },
  );
  await expectProjected(harness, paymentIntentId, 'expired');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'expired',
    'the scenario projection marks the elapsed intent expired (label: expired)',
  );
  return paymentIntentId;
}

async function runDuplicateRequestScenario(
  harness: ScenarioHarness,
  transcript: Transcript,
): Promise<string> {
  const paymentIntentId = await createScenarioIntent(harness, { key: 'demo-key' });
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'created',
    'payment intent created with a client idempotency key (label: submitted)',
  );
  const replayedId = await createScenarioIntent(harness, { key: 'demo-key' });
  if (replayedId !== paymentIntentId) {
    throw new Error('the duplicate create must replay the SAME payment intent');
  }
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'replayed',
    'the identical create with the same key replayed the same intent with 201 (no second quote or command)',
  );
  const conflictResponse = await harness.call('POST', '/v1/payment-intents', {
    body: { ...SCENARIO_CREATE_BODY, amountMinor: '2000', idempotencyKey: 'demo-key' },
  });
  if (conflictResponse.status !== 409) {
    throw new Error(
      'key reuse with a different request must be refused with 409, got HTTP ' +
        String(conflictResponse.status),
    );
  }
  const conflictProblem = ProblemDetailSchema.parse(await conflictResponse.json());
  if (conflictProblem.code !== 'idempotency_conflict') {
    throw new Error('expected idempotency_conflict, got ' + conflictProblem.code);
  }
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'key_conflict',
    'the same key with a different request was refused with 409 idempotency_conflict',
    { httpStatus: 409 },
  );
  await confirmScenarioIntent(harness, paymentIntentId);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'confirmed',
    'confirm accepted with 202; exactly one submit_payment command enqueued (label: processing)',
    { httpStatus: 202 },
  );
  const duplicateConfirm = await harness.call('POST', confirmPath(paymentIntentId));
  if (duplicateConfirm.status !== 409) {
    throw new Error(
      'the duplicate confirm must be refused with 409, got HTTP ' + String(duplicateConfirm.status),
    );
  }
  const duplicateProblem = ProblemDetailSchema.parse(await duplicateConfirm.json());
  if (duplicateProblem.code !== 'state_conflict') {
    throw new Error('expected state_conflict, got ' + duplicateProblem.code);
  }
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'duplicate_confirm_refused',
    'the duplicate confirm was refused with 409 state_conflict (no second command)',
    { httpStatus: 409 },
  );
  const batch = await harness.worker.runBatch();
  if (batch.claimed !== 1 || batch.published !== 1) {
    throw new Error(
      'duplicate scenario expected exactly one published submission: ' + JSON.stringify(batch),
    );
  }
  await expectProjected(harness, paymentIntentId, 'completed');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'transfer_completed',
    'a single submission completed the payment; the projection completed it (label: recipient_credited_simulated)',
    { workerBatch: batch },
  );
  return paymentIntentId;
}

async function runAmbiguousTimeoutScenario(
  harness: ScenarioHarness,
  transcript: Transcript,
  retryBackoffMs: number,
): Promise<string> {
  const paymentIntentId = await createScenarioIntent(harness);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'created',
    'payment intent created with a valid simulator quote (label: submitted)',
  );
  await confirmScenarioIntent(harness, paymentIntentId);
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'confirmed',
    'confirm accepted with 202; the simulator is scripted for an ambiguous timeout (label: processing)',
    { httpStatus: 202 },
  );
  const firstBatch = await harness.worker.runBatch();
  if (firstBatch.claimed !== 1 || firstBatch.pendingRetry !== 1) {
    throw new Error(
      'ambiguous scenario expected one claim scheduled for retry: ' + JSON.stringify(firstBatch),
    );
  }
  await expectProjected(harness, paymentIntentId, 'unknown_reconciliation');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'ambiguous',
    'the submission outcome is unknown (timeout_unknown); the message stays pending and the projection requires reconciliation (label: unknown_needs_reconciliation)',
    { workerBatch: firstBatch },
  );
  harness.clock.advance(retryBackoffMs + 500);
  const secondBatch = await harness.worker.runBatch();
  if (secondBatch.claimed !== 1 || secondBatch.published !== 1) {
    throw new Error(
      'ambiguous scenario expected the reconciliation attempt to publish: ' +
        JSON.stringify(secondBatch),
    );
  }
  await expectProjected(harness, paymentIntentId, 'completed');
  await recordStep(
    harness,
    transcript,
    paymentIntentId,
    'reconciled',
    'the worker queried the ORIGINAL external id — never resubmitting a new one — and the projection completed the payment (label: recipient_credited_simulated)',
    { workerBatch: secondBatch },
  );
  const submissions = harness.sponsorLog.submissionOutcomes;
  if (submissions.length !== 1) {
    throw new Error(
      'the ambiguous scenario must issue exactly one external submission, got ' +
        String(submissions.length),
    );
  }
  const first = submissions[0]?.externalTransferId ?? null;
  const queries = harness.sponsorLog.queryExternalIds;
  if (first === null || queries.length !== 1 || queries[0] !== first) {
    throw new Error('reconciliation must query the ORIGINAL external id exactly once');
  }
  return paymentIntentId;
}

function scriptFor(scenario: ScenarioName): readonly SimulatorScenario[] {
  if (scenario === 'rejection') {
    return ['reject'];
  }
  if (scenario === 'ambiguous_timeout_reconciliation') {
    return ['timeout_unknown'];
  }
  return ['success'];
}

/**
 * Runs one deterministic end-to-end scenario and returns its transcript plus the
 * evidence summary (single-submission invariants). The harness is closed before
 * returning.
 */
export async function runScenario(
  scenario: ScenarioName,
  options: ScenarioOptions = {},
): Promise<ScenarioRunResult> {
  const quoteValidityMs = options.quoteValidityMs ?? DEFAULT_QUOTE_VALIDITY_MS;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const harness = await startHarness({
    script: scriptFor(scenario),
    quoteValidityMs,
    retryBackoffMs,
  });
  try {
    const transcript: Transcript = [];
    let paymentIntentId: string;
    switch (scenario) {
      case 'success':
        paymentIntentId = await runSuccessScenario(harness, transcript);
        break;
      case 'rejection':
        paymentIntentId = await runRejectionScenario(harness, transcript);
        break;
      case 'expiry':
        paymentIntentId = await runExpiryScenario(harness, transcript, quoteValidityMs);
        break;
      case 'duplicate_request':
        paymentIntentId = await runDuplicateRequestScenario(harness, transcript);
        break;
      case 'ambiguous_timeout_reconciliation':
        paymentIntentId = await runAmbiguousTimeoutScenario(harness, transcript, retryBackoffMs);
        break;
    }
    const events = harness.events.listForIntent(paymentIntentId);
    return {
      scenario,
      paymentIntentId,
      transcript,
      externalSubmissions: [...harness.sponsorLog.submissionOutcomes],
      reconciliationQueries: [...harness.sponsorLog.queryExternalIds],
      outboxCommandCount: harness.outbox.messageCount(),
      submissionEventCount: events.filter(
        (event) => event.eventType === WORKER_SUBMISSION_EVENT.eventType,
      ).length,
      reconciliationEventCount: events.filter(
        (event) => event.eventType === WORKER_RECONCILIATION_EVENT.eventType,
      ).length,
    };
  } finally {
    await harness.close();
  }
}
