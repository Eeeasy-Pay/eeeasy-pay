// Postgres client factory for the persistence package (server-side only).
// The connection URL is a secret and only ever read from the environment/config.
//
// bigint columns are parsed to JS bigint: every amount in this product is an exact
// integer minor unit and must never round-trip through binary floating point
// (GUARDRAILS.md #4). bytea columns arrive as Buffer and are converted to hex
// digests at the port boundary by the repositories.

import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;

/** Ambient client: the ambient transaction if one is open, otherwise the pool. */
export type DbLike = Sql;

export function createPersistenceSql(url: string): Sql {
  return postgres(url, {
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: BigInt,
        serialize: (value: bigint | number): string => value.toString(),
      },
    },
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

/** Hex digest (64 chars) -> 32-byte Buffer for bytea parameters. */
export function hexToBuffer(hex: string): Buffer {
  const trimmed = hex.startsWith('0x') ? hex.slice(2) : hex;
  const buf = Buffer.from(trimmed, 'hex');
  if (buf.length !== 32) {
    throw new Error('expected a 32-byte sha256 hex digest');
  }
  return buf;
}

/** bytea column value (Buffer) -> hex digest at the port boundary. */
export function toHex(value: Buffer): string {
  return value.toString('hex');
}
