// Canonicalization and deterministic digests for the Payment Authorization Layer.
// No Node or DOM built-ins: a compact pure-JS SHA-256 keeps this package portable, typed under
// ES2022-only libs, and reviewable.

// SHA-256 round constants (FIPS 180-4).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

const HEX = '0123456789abcdef';

/** Minimal UTF-8 encoder (code-point correct, including surrogate pairs). */
function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

function sha256Bytes(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = message.length;
  // Smallest multiple of 64 that fits len + 1 (0x80 byte) + 8 (bit-length word).
  const total = ((len + 9 + 63) >> 6) * 64;
  const buf = new Uint8Array(total);
  buf.set(message);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor((len * 8) / 4294967296));
  view.setUint32(total - 4, (len * 8) >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4);
    }
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let a = H[0]!,
      b = H[1]!,
      c = H[2]!,
      d = H[3]!,
      e = H[4]!,
      f = H[5]!,
      g = H[6]!,
      h = H[7]!;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setUint32(i * 4, H[i]!);
  }
  return out;
}

/** SHA-256 hex digest of a UTF-8 string (verified against FIPS test vectors). */
export function sha256Hex(input: string): string {
  const digest = sha256Bytes(utf8Bytes(input));
  let hex = '';
  for (const b of digest) {
    hex += HEX[(b >>> 4) & 0xf]! + HEX[b & 0xf]!;
  }
  return hex;
}

/** Stable JSON canonicalization: object keys sorted lexicographically at every depth. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(record[k])).join(',') + '}';
}

/**
 * Server-scoped idempotency fingerprint: digest over (actor, operation, canonical request).
 * The client-supplied key is only an untrusted correlation input (ADR-005).
 */
export function idempotencyFingerprint(actor: string, operation: string, body: unknown): string {
  return sha256Hex(actor + '\u0000' + operation + '\u0000' + canonicalize(body));
}

/** Digest of a client idempotency key. Only the digest is ever stored server-side. */
export function idempotencyKeyDigest(key: string): string {
  return sha256Hex(key);
}

/**
 * The exact immutable quote terms a confirmation must match. Amounts are decimal strings of
 * exact minor units so the digest is JSON-safe. Any change in these terms must invalidate
 * the binding: the confirm command verifies actor, ownership, terms, expiry, and state.
 */
export interface QuoteBindingTerms {
  readonly quoteId: string;
  readonly paymentIntentId: string;
  readonly providerKey: string;
  readonly partnerQuoteRef: string;
  readonly apiProfile: string;
  readonly currency: string;
  readonly requestedAmountMinor: string;
  readonly quotedFeeMinor: string;
  readonly payerDebitMinor: string;
  readonly recipientAmountMinor: string;
  readonly feeRuleVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Binding digest over the canonical quote terms (mirrors payment_quotes.binding_hash). */
export function quoteBindingSha256(terms: QuoteBindingTerms): string {
  return sha256Hex(canonicalize(terms));
}
