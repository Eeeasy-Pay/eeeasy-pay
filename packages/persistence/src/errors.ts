import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InviteUnavailableError,
  PaymentIntentNotFoundError,
  PaymentStateConflictError,
  QuoteNotBindableError,
  RouteIneligibleError,
} from '@eeeasy-pay/ports';

/**
 * Maps reviewed-database SQLSTATE + message signatures onto the typed command errors from
 * packages/ports. Anything unmatched is returned unchanged so programming and connection
 * errors stay visible as-is (GUARDRAILS.md: record the question instead of guessing).
 */
export function mapDbError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') {
    return error;
  }
  const message = error.message;
  if (code === '22023') {
    if (message.includes('idempotency key reused')) {
      return new IdempotencyConflictError();
    }
    if (message.includes('quote missing')) {
      return new QuoteNotBindableError();
    }
    if (message.includes('provider event id reused')) {
      return new InboxPayloadConflictError();
    }
  }
  if (code === '42501') {
    if (message.includes('payment intent not found for actor')) {
      return new PaymentIntentNotFoundError();
    }
    if (message.includes('invite unavailable')) {
      return new InviteUnavailableError();
    }
  }
  if (code === '55000') {
    if (message.includes('not confirmable')) {
      return new PaymentStateConflictError();
    }
    if (message.includes('no longer eligible')) {
      return new RouteIneligibleError();
    }
  }
  return error;
}

/** Runs a database operation and rethrows typed errors where the reviewed functions define them. */
export async function mapDbErrorAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapDbError(error);
  }
}
