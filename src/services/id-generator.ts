// Centralized frontend ID generation (RFC 9562 UUIDv7).
//
// The plan requires stable application-generated IDs *before* persistence so
// optimistic UI can reference an entity immediately and a lost backend response
// can be safely replayed with the same ID. Native `crypto.randomUUID()` only
// produces UUIDv4, so we generate UUIDv7 ourselves.

export interface IdGenerator {
  nextId(): string;
}

/**
 * RFC 9562 UUIDv7: a 48-bit Unix-timestamp (milliseconds) followed by 74 bits
 * of randomness, with the version (0b0111) and variant (0b10) fields set.
 */
export class UuidV7Generator implements IdGenerator {
  nextId(): string {
    const ts = BigInt(Date.now());
    const bytes = new Uint8Array(16);

    // Random remainder (10 bytes after the 6-byte timestamp).
    const random = new Uint8Array(10);
    crypto.getRandomValues(random);

    // Bytes 0..5: 48-bit timestamp, big-endian (top byte is NUL because today's
    // epoch fits in 42 bits, but we write all 6 bytes to stay RFC-compliant).
    for (let i = 0; i < 6; i++) {
      bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
    }
    // Bytes 6..15: randomness.
    bytes.set(random, 6);

    // Set version (byte 6 high nibble = 7) and variant (byte 8 high bits = 10).
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    return formatUuid(bytes);
  }
}

/** Formats 16 bytes into the canonical 8-4-4-4-12 UUID string. */
function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
