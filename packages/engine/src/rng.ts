// Seeded RNG (CLAUDE.md invariant 1). sfc32 seeded by cyrb128. The RNG state is four int32 words
// stored inside MatchState, so applyAction/advancePhase stay pure and a match can be replayed from its log.

export type RngState = [number, number, number, number];

/** cyrb128: hashes a string seed into four 32-bit words. */
function cyrb128(str: string): RngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 | 0, h2 | 0, h3 | 0, h4 | 0];
}

/** Mutable wrapper over an RngState. The engine only ever uses it on a freshly cloned state. */
export class Rng {
  constructor(public readonly s: RngState) {}

  static fromSeed(seed: string): Rng {
    const rng = new Rng(cyrb128(seed));
    for (let i = 0; i < 15; i++) rng.nextUint32(); // warm-up
    return rng;
  }

  nextUint32(): number {
    const s = this.s;
    const a = s[0];
    const b = s[1];
    const c = s[2];
    const d = s[3];
    const t = (((a + b) | 0) + d) | 0;
    s[3] = (d + 1) | 0;
    s[0] = b ^ (b >>> 9);
    s[1] = (c + (c << 3)) | 0;
    const c2 = (c << 21) | (c >>> 11);
    s[2] = (c2 + t) | 0;
    return t >>> 0;
  }

  /** Unbiased integer in [0, n), by rejection sampling. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 0x1_0000_0000) throw new RangeError(`nextInt(${n})`);
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const u = this.nextUint32();
      if (u < limit) return u % n;
    }
  }

  /** True with probability percent/100, using integer arithmetic only. */
  chancePercent(percent: number): boolean {
    return this.nextInt(100) < percent;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from empty list');
    return items[this.nextInt(items.length)] as T;
  }
}
