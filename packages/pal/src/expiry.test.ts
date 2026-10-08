import { describe, expect, it } from 'vitest';
import { projectQuoteStatus } from './expiry.ts';

const expiresAt = '2026-10-08T12:00:00.000Z';

describe('projectQuoteStatus (read-only projection)', () => {
  it('valid and confirmable strictly before expiry', () => {
    expect(projectQuoteStatus(expiresAt, '2026-10-08T11:59:59.999Z')).toEqual({
      quoteStatus: 'valid',
      canConfirm: true,
    });
  });
  it('expired exactly AT the boundary', () => {
    expect(projectQuoteStatus(expiresAt, expiresAt)).toEqual({
      quoteStatus: 'expired',
      canConfirm: false,
    });
  });
  it('expired after the boundary', () => {
    expect(projectQuoteStatus(expiresAt, '2026-10-08T12:00:00.001Z')).toEqual({
      quoteStatus: 'expired',
      canConfirm: false,
    });
  });
  it('rejects invalid timestamps instead of guessing', () => {
    expect(() => projectQuoteStatus('nope', '2026-10-08T00:00:00.000Z')).toThrow();
    expect(() => projectQuoteStatus(expiresAt, 'nope')).toThrow();
  });
});
