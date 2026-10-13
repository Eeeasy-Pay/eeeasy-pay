// Structure-only bearer authentication (SIMULATOR ONLY, OPEN_DECISIONS.md B-01).
// This decodes a JWT-shaped token and trusts its `sub` claim; it verifies NO signature and
// grants NO real identity. A real identity provider is a production blocker; nothing here
// may be copied into anything that faces a customer or a partner.

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlDecode(segment: string): string {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const ch of segment) {
    if (ch === '=') {
      break;
    }
    const value = BASE64URL_ALPHABET.indexOf(ch);
    if (value < 0) {
      throw new UnauthenticatedError('bearer token is not base64url encoded');
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new UnauthenticatedError('bearer token payload is not valid UTF-8');
  }
}

/** Extracts the `sub` claim of a JWT-shaped bearer token. Verifies NO signature (B-01). */
export function bearerSubject(authorization: string | undefined): string {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new UnauthenticatedError('an Authorization: Bearer token is required');
  }
  const token = authorization.slice('Bearer '.length);
  const segments = token.split('.');
  if (segments.length !== 3) {
    throw new UnauthenticatedError('bearer token must have three JWT segments');
  }
  const payloadSegment = segments[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment)) as unknown;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      throw error;
    }
    throw new UnauthenticatedError('bearer token payload is not valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new UnauthenticatedError('bearer token payload must be a JSON object');
  }
  const sub = (payload as Record<string, unknown>)['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthenticatedError('bearer token has no subject claim');
  }
  return sub;
}
