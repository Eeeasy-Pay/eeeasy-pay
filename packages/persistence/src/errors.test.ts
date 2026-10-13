import { describe, expect, it } from 'vitest';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  InviteUnavailableError,
  PaymentIntentNotFoundError,
  PaymentStateConflictError,
  QuoteNotBindableError,
  RouteIneligibleError,
} from '@eeeasy-pay/ports';
import { mapDbError, mapDbErrorAsync } from './errors.ts';

function pgError(code: string, message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

describe('mapDbError (reviewed SQLSTATE signatures)', () => {
  it('maps 22023 idempotency key reuse', () => {
    expect(
      mapDbError(pgError('22023', 'idempotency key reused with different request')),
    ).toBeInstanceOf(IdempotencyConflictError);
  });

  it('maps 22023 quote-not-bindable', () => {
    expect(
      mapDbError(pgError('22023', 'quote missing, expired, or not bound to intent')),
    ).toBeInstanceOf(QuoteNotBindableError);
  });

  it('maps 22023 inbox payload conflict', () => {
    expect(
      mapDbError(pgError('22023', 'provider event id reused with different payload hash')),
    ).toBeInstanceOf(InboxPayloadConflictError);
  });

  it('maps 42501 intent-not-found-for-actor', () => {
    expect(mapDbError(pgError('42501', 'payment intent not found for actor'))).toBeInstanceOf(
      PaymentIntentNotFoundError,
    );
  });

  it('maps 42501 invite-unavailable', () => {
    expect(mapDbError(pgError('42501', 'invite unavailable'))).toBeInstanceOf(
      InviteUnavailableError,
    );
  });

  it('maps 55000 state conflict', () => {
    expect(
      mapDbError(pgError('55000', 'payment is not confirmable in current state')),
    ).toBeInstanceOf(PaymentStateConflictError);
  });

  it('maps 55000 route ineligible', () => {
    expect(
      mapDbError(pgError('55000', 'source link or recipient alias is no longer eligible')),
    ).toBeInstanceOf(RouteIneligibleError);
  });

  it('returns unmatched database errors unchanged', () => {
    const original = pgError('23505', 'duplicate key value violates unique constraint');
    expect(mapDbError(original)).toBe(original);
    const other22023 = pgError('22023', 'some other envelope problem');
    expect(mapDbError(other22023)).toBe(other22023);
  });

  it('returns non-database errors unchanged', () => {
    const original = new Error('connection reset by peer');
    expect(mapDbError(original)).toBe(original);
    expect(mapDbError('not an error')).toBe('not an error');
  });
});

describe('mapDbErrorAsync', () => {
  it('passes successful results through', async () => {
    await expect(mapDbErrorAsync(async () => 42)).resolves.toBe(42);
  });

  it('maps errors thrown by the operation', async () => {
    await expect(
      mapDbErrorAsync(async () => {
        throw pgError('22023', 'idempotency key reused with different request');
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
