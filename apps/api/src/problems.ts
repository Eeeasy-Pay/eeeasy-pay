// RFC 9457-style problem details for the product API. The closed problem-code set lives in
// packages/contracts (PROBLEM_CODES); this module only maps codes to stable titles and
// builds type URIs, so wire responses can never invent or leak new codes.
import type { ProblemCode, ProblemDetail, ProblemStatus } from '@eeeasy-pay/contracts';

const TITLES: Readonly<Record<ProblemCode, string>> = {
  validation_error: 'The request is not valid for this operation.',
  unauthenticated: 'Authentication is required for this operation.',
  forbidden: 'The authenticated actor may not perform this operation.',
  not_found: 'The requested resource does not exist.',
  quote_expired: 'The quote has elapsed; request a new quote.',
  quote_not_bound: 'No quote is bound to this payment intent.',
  state_conflict: 'The payment intent state does not allow this operation.',
  idempotency_conflict: 'This idempotency key was already used with a different request.',
  rate_limited: 'Too many requests; retry later.',
  unsupported_currency: 'The currency is not supported by the current profile.',
  simulator_limit: 'A simulator-only limit was reached.',
  needs_reconciliation: 'The transfer outcome is unknown and must be reconciled.',
  internal_error: 'An unexpected error occurred.',
};

export interface ProblemInput {
  readonly status: ProblemStatus;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly correlationId: string;
  readonly instance?: string;
}

export function problem(input: ProblemInput): ProblemDetail {
  const detail: ProblemDetail = {
    type: 'urn:eeeasy-pay:problem:' + input.code,
    title: TITLES[input.code],
    status: input.status,
    code: input.code,
    detail: input.detail,
    correlationId: input.correlationId,
  };
  if (input.instance === undefined) {
    return detail;
  }
  return { ...detail, instance: input.instance };
}
