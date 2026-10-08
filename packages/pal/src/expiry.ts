// Read-only quote expiry projection (ADR-007/D-04).
// Expiry is enforced at COMMAND time inside the confirm transaction (migration 0003);
// reads may PROJECT an elapsed quote as expired without mutating any row.

export type QuoteStatus = 'valid' | 'expired';

export interface QuoteProjection {
  readonly quoteStatus: QuoteStatus;
  readonly canConfirm: boolean;
}

/**
 * Expired exactly when now >= expiresAt. This is a pure function returning a projection;
 * it never mutates payment state, and callers must not treat it as enforcement.
 */
export function projectQuoteStatus(expiresAt: string, nowIso: string): QuoteProjection {
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(expiresAtMs) || Number.isNaN(nowMs)) {
    throw new Error('projectQuoteStatus requires valid ISO-8601 timestamps');
  }
  const expired = nowMs >= expiresAtMs;
  return { quoteStatus: expired ? 'expired' : 'valid', canConfirm: !expired };
}
