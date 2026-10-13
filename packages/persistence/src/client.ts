// Postgres client factory for the persistence package (server-side only).
// The connection URL is a secret and only ever read from the environment/config.
//
// bigint columns are parsed to JS bigint: every amount in this product is an exact
// integer minor unit and must never round-trip through binary floating point
// (GUARDRAILS.md #4). bytea columns arrive as Buffer and are converted to hex
// digests at the port boundary by the repositories.

import postgres from 'postgres';

function openPersistenceSql(url: string) {
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

/**
 * Typed client. The ReturnType of this non-generic wrapper keeps the bigint custom
 * type, so bigint parameters (every minor-unit amount) are accepted by the sql
 * templates; ReturnType<typeof postgres> alone would erase it to Sql<{}> and reject
 * them.
 */
export type Sql = ReturnType<typeof openPersistenceSql>;

/** Ambient client: the ambient transaction if one is open, otherwise the pool. */
export type DbLike = Sql;

export function createPersistenceSql(url: string): Sql {
  return openPersistenceSql(url);
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

/**
 * jsonb parameter for a safe payload object. postgres.js serializes jsonb
 * parameters (oid 3802) with JSON.stringify, so the object is encoded exactly
 * once; passing a pre-stringified string would double-encode it, and interpolating
 * a raw object with a ::jsonb cast is rejected by the template types.
 */
export function jsonbParameter(
  db: DbLike,
  value: Readonly<Record<string, unknown>>,
): postgres.Parameter {
  return db.json(value as unknown as postgres.JSONValue);
}
