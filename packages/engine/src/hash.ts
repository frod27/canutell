// Deterministic, dependency-free hashing for `state_hash` (SPEC §Data schema). Not cryptographic:
// it identifies which exact view a seat saw, so two independent 53-bit hashes (106 bits) are plenty.

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 28 hex chars (2 × 14). */
export function hashString(str: string): string {
  return (
    cyrb53(str, 0).toString(16).padStart(14, '0') + cyrb53(str, 0x9e3779b9).toString(16).padStart(14, '0')
  );
}

/**
 * Hash of a JSON-serializable value. JSON.stringify is deterministic here because every object the
 * engine builds has a fixed key insertion order and contains no Maps, Sets or undefined values.
 */
export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}
