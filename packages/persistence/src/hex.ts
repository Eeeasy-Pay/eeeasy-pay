// Hex-digest <-> bytea boundary helpers. Digests are hex strings in product code and
// bytea in Postgres; invalid digests fail loudly instead of silently truncating.

const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/i;

export function hexToBuffer(hex: string): Buffer {
  if (!HEX_PATTERN.test(hex)) {
    throw new Error('invalid hex digest (expected an even number of hex characters): ' + hex);
  }
  return Buffer.from(hex, 'hex');
}

export function bufferToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
