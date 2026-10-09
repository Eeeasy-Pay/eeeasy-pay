import { z } from 'zod';

/**
 * Shared V1 wire primitives. Money is ALWAYS a decimal string of exact integer minor
 * units (ADR-004) — never a float, never a number. Product resource identifiers are
 * UUIDs; timestamps are ISO-8601 UTC strings emitted by the server.
 */

/** Uppercase 3-letter currency code (placeholder set until the partner profile fixes it, B-08). */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Non-negative minor units: "0" or a positive integer without leading zeros. */
export const NonNegativeMinorSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** Positive minor units: a payment or split amount must be strictly greater than zero. */
export const PositiveMinorSchema = z.string().regex(/^[1-9][0-9]*$/);

/** UUID-format product resource identifier (server-generated). */
export const UuidSchema = z.string().uuid();

/** ISO-8601 UTC timestamp. */
export const TimestampSchema = z.string().datetime();
