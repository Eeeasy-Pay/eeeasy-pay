// Product HTTP API (TICKET-003). SIMULATOR ONLY: no real bank, DFSP, or scheme component
// is reached and nothing here moves money. Product routes only (GUARDRAILS.md #7): no
// scheme or partner endpoint is ever exposed. GET handlers are read-only projections: an
// elapsed quote is PROJECTED as expired without mutating any row (ADR-007); expiry is
// enforced only at command time inside the confirm transaction. Idempotency is
// server-scoped (ADR-005): the fingerprint is actor + operation + canonical request; a
// client idempotency key is an untrusted correlation input whose digest is stored.

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { CreatePaymentIntentRequestV1Schema, statusLabelFor } from '@eeeasy-pay/contracts';
import type {
  ConfirmResponseV1,
  PaymentIntentV1,
  PaymentStatusV1,
  ProblemCode,
  ProblemStatus,
  QuoteV1,
  QuoteStatusProjectionV1,
} from '@eeeasy-pay/contracts';
import { assertTransition, MoneyError, parseMinorUnits, quoteTotals, StateError } from '@eeeasy-pay/domain';
import {
  canonicalize,
  idempotencyKeyDigest,
  projectQuoteStatus,
  quoteBindingSha256,
  sha256Hex,
} from '@eeeasy-pay/pal';
import type { QuoteBindingTerms } from '@eeeasy-pay/pal';
import type {
  Clock,
  IdempotencyRepository,
  OutboxRepository,
  SponsorDfspPort,
  TransactionBoundary,
  UuidGenerator,
} from '@eeeasy-pay/ports';
import { bearerSubject, UnauthenticatedError } from './auth.ts';
import type { IntentRecord, MemoryIntentStore, MemoryQuoteStore } from './memory.ts';
import { problem } from './problems.ts';

const MAX_BODY_BYTES = 64 * 1024;
const OPERATION_CREATE = 'create_payment_intent';
const SIMULATOR_NOTE = 'simulated only: no bank debit, scheme transfer, or settlement occurred';

export interface ApiDeps {
  readonly clock: Clock;
  readonly uuid: UuidGenerator;
  readonly sponsor: SponsorDfspPort;
  readonly intents: MemoryIntentStore;
  readonly quotes: MemoryQuoteStore;
  readonly idempotency: IdempotencyRepository;
  readonly outbox: OutboxRepository;
  readonly tx: TransactionBoundary;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the size limit');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('request body is not valid JSON');
    this.name = 'InvalidJsonError';
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    resolve();
  });
}

function sendProblem(
  res: ServerResponse,
  status: ProblemStatus,
  code: ProblemCode,
  detail: string,
  correlationId: string,
): Promise<void> {
  return sendJson(res, status, problem({ status, code, detail, correlationId }));
}

function authorizationHeader(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return typeof header === 'string' ? header : undefined;
}

function summarizeIssues(issues: readonly { readonly message: string }[]): string {
  const parts = issues.map((issue) => issue.message);
  return parts.length === 0 ? 'the request is not valid' : 'invalid request: ' + parts.join('; ');
}

function projectIntent(deps: ApiDeps, record: IntentRecord): PaymentIntentV1 {
  const stored =
    record.currentQuoteId === undefined
      ? null
      : deps.quotes.findByQuoteId(record.currentQuoteId);
  const nowIso = deps.clock.nowIso();
  const quoteStatus: QuoteStatusProjectionV1 =
    stored === null ? 'unavailable' : projectQuoteStatus(stored.quote.expiresAt, nowIso).quoteStatus;
  const canConfirm =
    stored !== null &&
    record.state === 'quoted' &&
    projectQuoteStatus(stored.quote.expiresAt, nowIso).canConfirm;
  const projection = {
    paymentIntentId: record.paymentIntentId,
    state: record.state,
    currency: record.currency,
    requestedAmountMinor: record.requestedAmountMinor.toString(),
    quoteStatus,
    canConfirm,
    evidenceSource: 'SIMULATOR' as const,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return stored === null ? projection : { ...projection, quote: stored.quote };
}

async function createPaymentIntent(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
): Promise<void> {
  const raw = await readJson(req);
  const actorId = bearerSubject(authorizationHeader(req));
  const parsedRequest = CreatePaymentIntentRequestV1Schema.safeParse(raw);
  if (!parsedRequest.success) {
    await sendProblem(
      res,
      400,
      'validation_error',
      summarizeIssues(parsedRequest.error.issues),
      correlationId,
    );
    return;
  }
  const request = parsedRequest.data;
  const requestedAmountMinor = parseMinorUnits(request.amountMinor);
  const paymentIntentId = deps.uuid.next();
  const keyDigest = idempotencyKeyDigest(request.idempotencyKey ?? paymentIntentId);
  const requestDigest = sha256Hex(canonicalize(request));
  const replay = await deps.idempotency.reserve({
    actorId,
    operation: OPERATION_CREATE,
    keyDigest,
    requestDigest,
    resourceRef: paymentIntentId,
  });
  if (replay.replayed) {
    if (!replay.requestMatched) {
      await sendProblem(
        res,
        409,
        'idempotency_conflict',
        'this idempotency key was already used with a different request',
        correlationId,
      );
      return;
    }
    const existing = replay.resourceRef === undefined ? null : deps.intents.peek(replay.resourceRef);
    if (existing === null) {
      await sendProblem(
        res,
        500,
        'internal_error',
        'the original request could not be replayed',
        correlationId,
      );
      return;
    }
    await sendJson(res, 201, projectIntent(deps, existing));
    return;
  }
  await deps.tx.run(async () => {
    const outcome = await deps.sponsor.quote({
      paymentIntentId,
      correlationId,
      currency: request.currency,
      requestedAmountMinor,
    });
    const totals = quoteTotals(request.currency, requestedAmountMinor, outcome.quotedFeeMinor);
    if (
      outcome.payerDebitMinor !== totals.payerDebitMinor ||
      outcome.recipientAmountMinor !== totals.recipientAmountMinor
    ) {
      throw new Error('quote totals are inconsistent with the deterministic fee model');
    }
    const quoteId = deps.uuid.next();
    const nowIso = deps.clock.nowIso();
    assertTransition('created', 'quoting');
    assertTransition('quoting', 'quoted');
    const quote: QuoteV1 = {
      quoteId,
      apiProfile: outcome.apiProfile,
      currency: outcome.currency,
      requestedAmountMinor: outcome.requestedAmountMinor.toString(),
      quotedFeeMinor: outcome.quotedFeeMinor.toString(),
      payerDebitMinor: outcome.payerDebitMinor.toString(),
      recipientAmountMinor: outcome.recipientAmountMinor.toString(),
      feeRuleVersion: outcome.feeRuleVersion,
      issuedAt: outcome.issuedAt,
      expiresAt: outcome.expiresAt,
    };
    const binding: QuoteBindingTerms = {
      quoteId,
      paymentIntentId,
      providerKey: outcome.providerKey,
      partnerQuoteRef: outcome.partnerQuoteRef,
      apiProfile: outcome.apiProfile,
      currency: quote.currency,
      requestedAmountMinor: quote.requestedAmountMinor,
      quotedFeeMinor: quote.quotedFeeMinor,
      payerDebitMinor: quote.payerDebitMinor,
      recipientAmountMinor: quote.recipientAmountMinor,
      feeRuleVersion: quote.feeRuleVersion,
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
    };
    deps.quotes.put({ quoteId, quote, binding });
    deps.intents.put({
      paymentIntentId,
      actorId,
      state: 'quoted',
      currency: request.currency,
      requestedAmountMinor,
      currentQuoteId: quoteId,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await deps.idempotency.markAccepted({ actorId, operation: OPERATION_CREATE, keyDigest });
    await deps.idempotency.markCompleted({ actorId, operation: OPERATION_CREATE, keyDigest });
  });
  const record = deps.intents.peek(paymentIntentId);
  if (record === null) {
    throw new Error('payment intent missing after create');
  }
  await sendJson(res, 201, projectIntent(deps, record));
}

async function getPaymentIntent(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  paymentIntentId: string,
): Promise<void> {
  const actorId = bearerSubject(authorizationHeader(req));
  // Ownership failures and unknown ids both return the same 404: no enumeration.
  const record = await deps.intents.findOwnedById(paymentIntentId, actorId);
  if (record === null) {
    await sendProblem(res, 404, 'not_found', 'payment intent not found', correlationId);
    return;
  }
  await sendJson(res, 200, projectIntent(deps, record));
}

async function getPaymentStatus(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  paymentIntentId: string,
): Promise<void> {
  const actorId = bearerSubject(authorizationHeader(req));
  const record = await deps.intents.findOwnedById(paymentIntentId, actorId);
  if (record === null) {
    await sendProblem(res, 404, 'not_found', 'payment intent not found', correlationId);
    return;
  }
  const status: PaymentStatusV1 = {
    paymentIntentId: record.paymentIntentId,
    state: record.state,
    statusLabel: statusLabelFor(record.state, 'not_applicable'),
    settlementState: 'not_applicable',
    simulatorNote: SIMULATOR_NOTE,
  };
  await sendJson(res, 200, status);
}

async function confirmPaymentIntent(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  paymentIntentId: string,
): Promise<void> {
  const actorId = bearerSubject(authorizationHeader(req));
  const record = await deps.intents.findOwnedById(paymentIntentId, actorId);
  if (record === null) {
    await sendProblem(res, 404, 'not_found', 'payment intent not found', correlationId);
    return;
  }
  if (record.state !== 'quoted') {
    await sendProblem(
      res,
      409,
      'state_conflict',
      'only a quoted payment intent can be confirmed',
      correlationId,
    );
    return;
  }
  const stored =
    record.currentQuoteId === undefined
      ? null
      : deps.quotes.findByQuoteId(record.currentQuoteId);
  if (stored === null) {
    await sendProblem(
      res,
      409,
      'quote_not_bound',
      'no quote is bound to this payment intent',
      correlationId,
    );
    return;
  }
  const nowIso = deps.clock.nowIso();
  if (projectQuoteStatus(stored.quote.expiresAt, nowIso).quoteStatus === 'expired') {
    await sendProblem(
      res,
      409,
      'quote_expired',
      'the quote has elapsed; request a new quote',
      correlationId,
    );
    return;
  }
  const bindingDigest = quoteBindingSha256(stored.binding);
  const commandCorrelationId = deps.uuid.next();
  const safePayload: Readonly<Record<string, unknown>> = {
    paymentIntentId: record.paymentIntentId,
    quoteId: stored.quoteId,
    quoteBindingDigest: bindingDigest,
    correlationId: commandCorrelationId,
  };
  // Command transaction (ADR-006): the state transition and the durable outbox enqueue are
  // serialized in ONE unit. The worker (TICKET-005) submits to the sponsor port later.
  await deps.tx.run(async () => {
    assertTransition('quoted', 'user_authorized');
    deps.intents.put({ ...record, state: 'user_authorized', updatedAt: nowIso });
    await deps.outbox.enqueue({
      aggregateType: 'payment_intent',
      aggregateId: record.paymentIntentId,
      commandType: 'submit_transfer',
      schemaVersion: 1,
      idempotencyKeyDigest: idempotencyKeyDigest(record.paymentIntentId + '\u0000' + bindingDigest),
      payloadDigest: sha256Hex(canonicalize(safePayload)),
      safePayload,
    });
  });
  const response: ConfirmResponseV1 = {
    paymentIntentId: record.paymentIntentId,
    accepted: true,
    statusLabel: statusLabelFor('user_authorized', 'not_applicable'),
  };
  await sendJson(res, 202, response);
}

async function handle(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const correlationId = deps.uuid.next();
  try {
    const url = new URL(req.url ?? '/', 'http://eeeasy-pay.local');
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    const isRoot =
      segments.length === 2 && segments[0] === 'v1' && segments[1] === 'payment-intents';
    if (method === 'POST' && isRoot) {
      await createPaymentIntent(deps, req, res, correlationId);
      return;
    }
    if (segments[0] === 'v1' && segments[1] === 'payment-intents' && segments[2] !== undefined) {
      const paymentIntentId = segments[2];
      if (method === 'GET' && segments.length === 3) {
        await getPaymentIntent(deps, req, res, correlationId, paymentIntentId);
        return;
      }
      if (method === 'POST' && segments.length === 4 && segments[3] === 'confirm') {
        await confirmPaymentIntent(deps, req, res, correlationId, paymentIntentId);
        return;
      }
      if (method === 'GET' && segments.length === 4 && segments[3] === 'status') {
        await getPaymentStatus(deps, req, res, correlationId, paymentIntentId);
        return;
      }
    }
    await sendProblem(res, 404, 'not_found', 'unknown route', correlationId);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof UnauthenticatedError) {
      await sendProblem(res, 401, 'unauthenticated', error.message, correlationId);
      return;
    }
    if (error instanceof BodyTooLargeError || error instanceof InvalidJsonError) {
      await sendProblem(res, 400, 'validation_error', error.message, correlationId);
      return;
    }
    if (error instanceof MoneyError) {
      await sendProblem(res, 400, 'validation_error', error.message, correlationId);
      return;
    }
    if (error instanceof StateError) {
      await sendProblem(res, 409, 'state_conflict', error.message, correlationId);
      return;
    }
    // Deliberately generic: internals never leak in responses.
    await sendProblem(res, 500, 'internal_error', 'an unexpected error occurred', correlationId);
  }
}

export function createApiApp(deps: ApiDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res);
  });
}
