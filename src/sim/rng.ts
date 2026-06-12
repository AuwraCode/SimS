/**
 * Deterministic randomness. Every stochastic decision in the simulation draws
 * from a named mulberry32 stream derived from the master seed, so a run is
 * fully reproducible from one number — and adding draws to one subsystem
 * cannot shift the sequence seen by another.
 */

export type Rng = () => number;

/** xmur3 string hash → 32-bit seed material. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 PRNG: tiny, fast, plenty for simulation use. Returns [0,1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent named sub-stream of the master seed. */
export function makeStream(masterSeed: number, name: string): Rng {
  return mulberry32(xmur3(`${name}:${masterSeed}`)());
}

export function uniform(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Box-Muller. Draws two uniforms per call (no caching — keeps draw counts predictable). */
export function normal(rng: Rng, mu: number, sigma: number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function normalClamped(rng: Rng, mu: number, sigma: number, lo: number, hi: number): number {
  return clamp(normal(rng, mu, sigma), lo, hi);
}

/** Sample an index from cumulative weights (last entry = total). */
export function pickCumulative(rng: Rng, cum: Float64Array): number {
  const r = rng() * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Stateless deterministic hash of an integer pair → [0,1). Used for
 * per-(agent,edge) route-cost tie noise without consuming stream state.
 */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
