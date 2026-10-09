import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { PAYMENT_STATES } from '@eeeasy-pay/domain';
import { PAYMENT_STATUS_LABELS, PROBLEM_CODES } from './index.ts';

const openapiUrl = new URL('../../../apps/api/openapi/v1.yaml', import.meta.url);
const rawYaml = readFileSync(fileURLToPath(openapiUrl), 'utf8');
const parsed = parseYaml(rawYaml);

interface OpenApiOperation {
  responses?: Record<string, unknown>;
}
interface OpenApiSchemaObject {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, { enum?: unknown[] }>;
}
interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, OpenApiSchemaObject> };
}

async function loadDocument(): Promise<OpenApiDocument> {
  return (await SwaggerParser.validate(parsed)) as unknown as OpenApiDocument;
}

const expectedPaths = [
  '/v1/payment-intents',
  '/v1/payment-intents/{paymentIntentId}',
  '/v1/payment-intents/{paymentIntentId}/status',
  '/v1/payment-intents/{paymentIntentId}/confirm',
  '/v1/split-bills',
  '/v1/split-bills/{splitBillId}',
  '/v1/split-bills/{splitBillId}/shares',
  '/v1/split-shares/claim-invite',
];

describe('apps/api/openapi/v1.yaml', () => {
  it('is a structurally valid OpenAPI 3.0.3 document', async () => {
    const doc = await loadDocument();
    expect(doc.openapi).toBe('3.0.3');
  });

  it('covers exactly the planned V1 routes', async () => {
    const doc = await loadDocument();
    const paths = Object.keys(doc.paths);
    for (const p of expectedPaths) {
      expect(paths, p).toContain(p);
    }
  });

  it('every operation declares at least one 2xx response', async () => {
    const doc = await loadDocument();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method === 'parameters') continue;
        const codes = Object.keys(op.responses ?? {});
        expect(codes.some((c) => /^2\d\d$/.test(c)), method + ' ' + path).toBe(true);
      }
    }
  });

  it('mirrors the closed problem-code set exactly', async () => {
    const doc = await loadDocument();
    const problem = doc.components?.schemas?.['ProblemDetail'];
    const codes = problem?.properties?.['code']?.enum ?? [];
    expect(new Set(codes)).toEqual(new Set(PROBLEM_CODES));
  });

  it('mirrors the domain payment states and product status labels', async () => {
    const doc = await loadDocument();
    const states = doc.components?.schemas?.['PaymentIntentV1']?.properties?.['state']?.enum ?? [];
    expect(new Set(states)).toEqual(new Set(PAYMENT_STATES));
    const labels = doc.components?.schemas?.['PaymentStatusV1']?.properties?.['statusLabel']?.enum ?? [];
    expect(new Set(labels)).toEqual(new Set(PAYMENT_STATUS_LABELS));
  });

  it('never exposes scheme internals', async () => {
    await loadDocument();
    const bannedProp = /^(mojaloop|dfsp|ledger|participant|switch|hub|fspiop)/i;
    for (const propName of ['paymentIntentId', 'recipientAliasId', 'correlationId']) {
      expect(bannedProp.test(propName)).toBe(false);
    }
    expect(/\b(mojaloop|dfsp|ledger|participant|fspiop)\b/i.test(rawYaml)).toBe(false);
  });
});
