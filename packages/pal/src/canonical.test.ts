import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  idempotencyFingerprint,
  idempotencyKeyDigest,
  quoteBindingSha256,
  sha256Hex,
} from './canonical.ts';

describe('sha256Hex (pure-JS FIPS 180-4)', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is deterministic and distinguishes inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
    expect(sha256Hex('12')).toBe(sha256Hex('12'));
  });
});

describe('canonicalize', () => {
  it('is independent of key order at every depth', () => {
    const a = canonicalize({ z: 1, a: { y: [1, { b: 2, a: 1 }], x: 'k' } });
    const b = canonicalize({ a: { x: 'k', y: [1, { a: 1, b: 2 }] }, z: 1 });
    expect(a).toBe(b);
  });
  it('does not confuse adjacent fields', () => {
    expect(canonicalize({ ab: 'c' })).not.toBe(canonicalize({ a: 'bc' }));
  });
});

describe('idempotency fingerprint (server-scoped)', () => {
  it('is stable for the same actor+operation+body regardless of key order', () => {
    const body1 = { amount: '1000', currency: 'XTS' };
    const body2 = { currency: 'XTS', amount: '1000' };
    expect(idempotencyFingerprint('user-1', 'create-payment-intent', body1)).toBe(
      idempotencyFingerprint('user-1', 'create-payment-intent', body2),
    );
  });
  it('changes with actor, operation, or body', () => {
    const base = idempotencyFingerprint('user-1', 'op', { a: 1 });
    expect(idempotencyFingerprint('user-2', 'op', { a: 1 })).not.toBe(base);
    expect(idempotencyFingerprint('user-1', 'op2', { a: 1 })).not.toBe(base);
    expect(idempotencyFingerprint('user-1', 'op', { a: 2 })).not.toBe(base);
  });
  it('digests client keys without storing them', () => {
    expect(idempotencyKeyDigest('client-key-1')).toBe(sha256Hex('client-key-1'));
    expect(idempotencyKeyDigest('client-key-1')).toHaveLength(64);
  });
});

describe('quote binding digest', () => {
  const terms = {
    quoteId: 'q-1',
    paymentIntentId: 'pi-1',
    providerKey: 'sim-dfsp',
    partnerQuoteRef: 'SQ-000001',
    apiProfile: 'SIMULATOR',
    currency: 'XTS',
    requestedAmountMinor: '1000',
    quotedFeeMinor: '1',
    payerDebitMinor: '1001',
    recipientAmountMinor: '1000',
    feeRuleVersion: 'simulator-flat-1',
    issuedAt: '2026-10-08T00:00:00.000Z',
    expiresAt: '2026-10-08T00:01:00.000Z',
  };
  it('is stable across property order', () => {
    const shuffled = { ...terms, apiProfile: terms.apiProfile };
    expect(quoteBindingSha256(terms)).toBe(quoteBindingSha256(shuffled));
    const reordered = Object.fromEntries(Object.entries(terms).reverse());
    expect(quoteBindingSha256(terms)).toBe(quoteBindingSha256(reordered as typeof terms));
  });
  it('changes if any term changes', () => {
    expect(quoteBindingSha256({ ...terms, quotedFeeMinor: '2' })).not.toBe(quoteBindingSha256(terms));
    expect(quoteBindingSha256({ ...terms, expiresAt: '2026-10-08T00:02:00.000Z' })).not.toBe(
      quoteBindingSha256(terms),
    );
  });
});
