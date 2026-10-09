import { z } from 'zod';
import { UuidSchema } from './shared.ts';

/**
 * Closed set of stable, safe problem codes (RFC 9457-style problem details). Do not add
 * codes that leak internals, partner names, or scheme details. The same closed set is
 * mirrored in apps/api/openapi/v1.yaml and cross-checked in CI (openapi.test.ts).
 */
export const PROBLEM_CODES = [
  'validation_error',
  'unauthenticated',
  'forbidden',
  'not_found',
  'quote_expired',
  'quote_not_bound',
  'state_conflict',
  'idempotency_conflict',
  'rate_limited',
  'unsupported_currency',
  'simulator_limit',
  'needs_reconciliation',
  'internal_error',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** HTTP statuses a problem response may use. Kept closed so clients can switch safely. */
export const PROBLEM_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export const ProblemDetailSchema = z.object({
  /** Stable problem type URI. */
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.union([
    z.literal(400),
    z.literal(401),
    z.literal(403),
    z.literal(404),
    z.literal(409),
    z.literal(422),
    z.literal(429),
    z.literal(500),
  ]),
  code: z.enum(PROBLEM_CODES),
  detail: z.string(),
  /** Server-generated correlation id for tracing one request end to end. */
  correlationId: UuidSchema,
  instance: z.string().min(1).optional(),
});

export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
