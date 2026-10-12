// TICKET-003 route acceptance tests. SIMULATOR ONLY: the sponsor port is the deterministic
// simulator, the clock is mutable, and identity is an unsigned JWT-shaped bearer token
// (OPEN_DECISIONS.md B-01). No test here implies bank debit, scheme transfer, or
// settlement; response bodies are validated against the published zod-first contracts.
import { Buffer } from 'node:buffer';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfirmResponseV1Schema,
  PaymentIntentV1Schema,
  PaymentStatusV1Schema,
  ProblemDetailSchema,
} from '@eeeasy-pay/contracts';
import { idempotencyKeyDigest, quoteBindingSha256 } from '@eeeasy-pay/pal';
import type { Clock, UuidGenerator } from '@eeeasy-pay/ports';
import { SimulatorSponsorDfspConnector } from '@eeeasy-pay/sponsor-dfsp-connector';
import { createApiApp } from './app.ts';
import {
  MemoryIdempotencyRepository,
  MemoryIntentStore,
  MemoryOutboxRepository,
  MemoryQuoteStore,
  MemoryTransaction,
} from './memory.ts';

const START_MS = new Date('2026-01-01T00:00:00.000Z').getTime();
const QUOTE_VALIDITY_MS = 60_000;
const USER_ONE_TOKEN = 'user-token-one';
const USER_TWO_TOKEN = 'user-token-two';

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

/** Unsigned JWT-shaped token: base64url(header).base64url(payload).base64url(nothing). */
function bearerToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return header + '.' + payload + '.';
}

interface Harness {
  readonly clock: MutableClock;
  readonly intents: MemoryIntentStore;
  readonly quotes: MemoryQuoteStore;
  readonly outbox: MemoryOutboxRepository;
  call(
    method: string,
    path: string,
    options?: { readonly token?: string; readonly body?: unknown },
  ): Promise<Response>;
}

const servers: Array<ReturnType<typeof createApiApp>> = [];

async function startHarness(): Promise<Harness> {
  const clock = new MutableClock();
  const uuid = new SequentialUuid();
  const sponsor = new SimulatorSponsorDfspConnector(clock, {
    quoteValidityMs: QUOTE_VALIDITY_MS,
    flatFeeMinor: 1n,
  });
  const intents = new MemoryIntentStore();
  const quotes = new MemoryQuoteStore();
  const idempotency = new MemoryIdempotencyRepository();
  const outbox = new MemoryOutboxRepository(uuid, clock);
  const tx = new MemoryTransaction();
  const server = createApiApp({ clock, uuid, sponsor, intents, quotes, idempotency, outbox, tx });
  servers.push(server);
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
  const call = (
    method: string,
    path: string,
    options?: { readonly token?: string; readonly body?: unknown },
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (options?.token !== undefined) {
      headers.authorization = 'Bearer ' + options.token;
    }
    if (options?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return fetch(baseUrl + path, {
      method,
      headers,
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };
  return { clock, intents, quotes, outbox, call };
}

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const VALID_CREATE_BODY = {
  sourceBankLinkId: '11111111-1111-4111-8111-111111111111',
  recipientAliasId: 'alias-7',
  currency: 'SDG',
  amountMinor: '1000',
};

async function createIntent(
  harness: Harness,
  options?: { readonly token?: string; readonly body?: unknown; readonly key?: string },
): Promise<Response> {
  const body =
    options?.body === undefined
      ? options?.key === undefined
        ? VALID_CREATE_BODY
        : { ...VALID_CREATE_BODY, idempotencyKey: options.key }
      : options.body;
  return harness.call('POST', '/v1/payment-intents', {
    token: options?.token === undefined ? bearerToken(USER_ONE_TOKEN) : options.token,
    body,
  });
}

describe('apps/api payment-intent routes (TICKET-003)', () => {
  it('rejects unauthenticated create calls with a 401 problem', async () => {
    const harness = await startHarness();
    const response = await harness.call('POST', '/v1/payment-intents', {
      body: VALID_CREATE_BODY,
    });
    expect(response.status).toBe(401);
    const problemDetail = ProblemDetailSchema.parse(await response.json());
    expect(problemDetail.code).toBe('unauthenticated');
  });

  it('rejects malformed bearer tokens with 401', async () => {
    const harness = await startHarness();
    const response = await createIntent(harness, { token: 'not-a-jwt' });
    expect(response.status).toBe(401);
    const problemDetail = ProblemDetailSchema.parse(await response.json());
    expect(problemDetail.code).toBe('unauthenticated');
  });

  it('creates a quoted payment intent with simulator evidence and a valid quote', async () => {
    const harness = await startHarness();
    const response = await createIntent(harness);
    expect(response.status).toBe(201);
    const intent = PaymentIntentV1Schema.parse(await response.json());
    expect(intent.state).toBe('quoted');
    expect(intent.requestedAmountMinor).toBe('1000');
    expect(intent.quoteStatus).toBe('valid');
    expect(intent.canConfirm).toBe(true);
    expect(intent.evidenceSource).toBe('SIMULATOR');
    expect(intent.quote?.quotedFeeMinor).toBe('1');
    expect(intent.quote?.payerDebitMinor).toBe('1001');
    expect(intent.quote?.recipientAmountMinor).toBe('1000');
    expect(intent.quote?.apiProfile).toBe('SIMULATOR');
  });

  it('rejects invalid bodies with a 400 validation_error problem', async () => {
    const harness = await startHarness();
    const decimal = await createIntent(harness, {
      body: { ...VALID_CREATE_BODY, amountMinor: '12.5' },
    });
    expect(decimal.status).toBe(400);
    const decimalProblem = ProblemDetailSchema.parse(await decimal.json());
    expect(decimalProblem.code).toBe('validation_error');
    const missing = await createIntent(harness, { body: { currency: 'SDG' } });
    expect(missing.status).toBe(400);
  });

  it('replays the same intent for a repeated key and conflicts on key reuse with a different request', async () => {
    const harness = await startHarness();
    const first = await createIntent(harness, { key: 'key-1' });
    expect(first.status).toBe(201);
    const firstIntent = PaymentIntentV1Schema.parse(await first.json());
    const replay = await createIntent(harness, { key: 'key-1' });
    expect(replay.status).toBe(201);
    const replayedIntent = PaymentIntentV1Schema.parse(await replay.json());
    expect(replayedIntent.paymentIntentId).toBe(firstIntent.paymentIntentId);
    const conflict = await createIntent(harness, {
      key: 'key-1',
      body: { ...VALID_CREATE_BODY, amountMinor: '2000' },
    });
    expect(conflict.status).toBe(409);
    const conflictProblem = ProblemDetailSchema.parse(await conflict.json());
    expect(conflictProblem.code).toBe('idempotency_conflict');
  });

  it('scopes idempotency keys per actor', async () => {
    const harness = await startHarness();
    const userOne = PaymentIntentV1Schema.parse(
      await (await createIntent(harness, { key: 'shared-key' })).json(),
    );
    const userTwo = PaymentIntentV1Schema.parse(
      await (
        await createIntent(harness, { key: 'shared-key', token: bearerToken(USER_TWO_TOKEN) })
      ).json(),
    );
    expect(userTwo.paymentIntentId).not.toBe(userOne.paymentIntentId);
  });

  it('hides other actors intents with the same 404 as unknown ids', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const own = await harness.call('GET', '/v1/payment-intents/' + created.paymentIntentId, {
      token: bearerToken(USER_ONE_TOKEN),
    });
    expect(own.status).toBe(200);
    const foreign = await harness.call('GET', '/v1/payment-intents/' + created.paymentIntentId, {
      token: bearerToken(USER_TWO_TOKEN),
    });
    expect(foreign.status).toBe(404);
    const problemDetail = ProblemDetailSchema.parse(await foreign.json());
    expect(problemDetail.code).toBe('not_found');
    const unknown = await harness.call('GET', '/v1/payment-intents/99999999-9999-4999-8999-999999999999', {
      token: bearerToken(USER_ONE_TOKEN),
    });
    expect(unknown.status).toBe(404);
  });

  it('projects an elapsed quote as expired on GET without mutating the record', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const before = harness.intents.peek(created.paymentIntentId);
    expect(before?.state).toBe('quoted');
    expect(before?.updatedAt).toBe(new Date(START_MS).toISOString());
    harness.clock.advance(QUOTE_VALIDITY_MS + 1);
    const response = await harness.call('GET', '/v1/payment-intents/' + created.paymentIntentId, {
      token: bearerToken(USER_ONE_TOKEN),
    });
    expect(response.status).toBe(200);
    const projected = PaymentIntentV1Schema.parse(await response.json());
    expect(projected.quoteStatus).toBe('expired');
    expect(projected.canConfirm).toBe(false);
    const after = harness.intents.peek(created.paymentIntentId);
    expect(after?.state).toBe('quoted');
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('refuses to confirm an elapsed quote with 409 quote_expired', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    harness.clock.advance(QUOTE_VALIDITY_MS + 1);
    const response = await harness.call(
      'POST',
      '/v1/payment-intents/' + created.paymentIntentId + '/confirm',
      { token: bearerToken(USER_ONE_TOKEN) },
    );
    expect(response.status).toBe(409);
    const problemDetail = ProblemDetailSchema.parse(await response.json());
    expect(problemDetail.code).toBe('quote_expired');
    expect(problemDetail.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('accepts a confirmation with 202 and enqueues exactly one bound submit_transfer command', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const response = await harness.call(
      'POST',
      '/v1/payment-intents/' + created.paymentIntentId + '/confirm',
      { token: bearerToken(USER_ONE_TOKEN) },
    );
    expect(response.status).toBe(202);
    const confirmed = ConfirmResponseV1Schema.parse(await response.json());
    expect(confirmed.accepted).toBe(true);
    expect(confirmed.statusLabel).toBe('processing');
    const claimed = await harness.outbox.claim({
      workerId: 'worker-1',
      limit: 10,
      leaseSeconds: 30,
    });
    expect(claimed.length).toBe(1);
    const message = claimed[0];
    if (message === undefined) {
      throw new Error('expected one claimed outbox message');
    }
    expect(message.commandType).toBe('submit_transfer');
    expect(message.aggregateType).toBe('payment_intent');
    expect(message.aggregateId).toBe(created.paymentIntentId);
    expect(message.schemaVersion).toBe(1);
    const quoteId = created.quote?.quoteId;
    const stored = quoteId === undefined ? null : harness.quotes.findByQuoteId(quoteId);
    if (stored === null) {
      throw new Error('quote missing from the store');
    }
    const bindingDigest = quoteBindingSha256(stored.binding);
    const safePayload = message.safePayload as Record<string, unknown>;
    expect(safePayload['quoteBindingDigest']).toBe(bindingDigest);
    expect(safePayload['paymentIntentId']).toBe(created.paymentIntentId);
    expect(safePayload['quoteId']).toBe(quoteId);
    expect(message.idempotencyKeyDigest).toBe(
      idempotencyKeyDigest(created.paymentIntentId + '\u0000' + bindingDigest),
    );
    const finished = await harness.outbox.finish({
      outboxMessageId: message.outboxMessageId,
      workerId: 'worker-1',
      leaseToken: message.leaseToken ?? '',
      published: true,
    });
    expect(finished).toBe(true);
    const requeued = await harness.outbox.claim({
      workerId: 'worker-1',
      limit: 10,
      leaseSeconds: 30,
    });
    expect(requeued.length).toBe(0);
  });

  it('refuses a duplicate confirmation with 409 state_conflict', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const first = await harness.call(
      'POST',
      '/v1/payment-intents/' + created.paymentIntentId + '/confirm',
      { token: bearerToken(USER_ONE_TOKEN) },
    );
    expect(first.status).toBe(202);
    const second = await harness.call(
      'POST',
      '/v1/payment-intents/' + created.paymentIntentId + '/confirm',
      { token: bearerToken(USER_ONE_TOKEN) },
    );
    expect(second.status).toBe(409);
    const problemDetail = ProblemDetailSchema.parse(await second.json());
    expect(problemDetail.code).toBe('state_conflict');
  });

  it('hides confirmations from other actors with 404', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const response = await harness.call(
      'POST',
      '/v1/payment-intents/' + created.paymentIntentId + '/confirm',
      { token: bearerToken(USER_TWO_TOKEN) },
    );
    expect(response.status).toBe(404);
    const problemDetail = ProblemDetailSchema.parse(await response.json());
    expect(problemDetail.code).toBe('not_found');
  });

  it('maps payment states to status labels with an explicit simulator note', async () => {
    const harness = await startHarness();
    const created = PaymentIntentV1Schema.parse(await (await createIntent(harness)).json());
    const basePath = '/v1/payment-intents/' + created.paymentIntentId;
    const quoted = PaymentStatusV1Schema.parse(
      await (
        await harness.call('GET', basePath + '/status', { token: bearerToken(USER_ONE_TOKEN) })
      ).json(),
    );
    expect(quoted.statusLabel).toBe('submitted');
    expect(quoted.settlementState).toBe('not_applicable');
    expect(quoted.simulatorNote).toBe(
      'simulated only: no bank debit, scheme transfer, or settlement occurred',
    );
    const confirmed = await harness.call('POST', basePath + '/confirm', {
      token: bearerToken(USER_ONE_TOKEN),
    });
    expect(confirmed.status).toBe(202);
    const processing = PaymentStatusV1Schema.parse(
      await (
        await harness.call('GET', basePath + '/status', { token: bearerToken(USER_ONE_TOKEN) })
      ).json(),
    );
    expect(processing.statusLabel).toBe('processing');
    const record = harness.intents.peek(created.paymentIntentId);
    if (record === null) {
      throw new Error('record missing');
    }
    harness.intents.put({ ...record, state: 'rejected' });
    const rejected = PaymentStatusV1Schema.parse(
      await (
        await harness.call('GET', basePath + '/status', { token: bearerToken(USER_ONE_TOKEN) })
      ).json(),
    );
    expect(rejected.state).toBe('rejected');
    expect(rejected.statusLabel).toBe('rejected');
  });

  it('returns 404 problems for unknown routes', async () => {
    const harness = await startHarness();
    const response = await harness.call('GET', '/v1/not-a-route', {
      token: bearerToken(USER_ONE_TOKEN),
    });
    expect(response.status).toBe(404);
    const problemDetail = ProblemDetailSchema.parse(await response.json());
    expect(problemDetail.code).toBe('not_found');
  });
});
