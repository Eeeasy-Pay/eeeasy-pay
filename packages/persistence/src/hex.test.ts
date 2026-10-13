import { describe, expect, it } from 'vitest';
import { bufferToHex, hexToBuffer } from './hex.ts';
import { sha256Hex } from '@eeeasy-pay/pal';

describe('hex <-> bytea boundary helpers', () => {
  it('round-trips a known digest', () => {
    const digest = sha256Hex('abc');
    expect(bufferToHex(hexToBuffer(digest))).toBe(digest);
  });

  it('produces lowercase hex', () => {
    expect(bufferToHex(new Uint8Array([0x0a, 0xff, 0x10]))).toBe('0aff10');
  });

  it('rejects odd-length input', () => {
    expect(() => hexToBuffer('abc')).toThrow(/invalid hex digest/);
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBuffer('zz')).toThrow(/invalid hex digest/);
    expect(() => hexToBuffer('')).toThrow(/invalid hex digest/);
  });
});
