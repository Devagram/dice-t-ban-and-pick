/**
 * Deterministic shuffling for `RANDOM` seeding.
 *
 * The same counter-based construction the engine uses for dice, and here for the same reason: a
 * bracket must be reproducible from its creation event. `Math.random` would make the seeding of a
 * tournament unrecoverable the moment the object hibernated, and the no-IO lint on this package
 * bans it outright.
 *
 * Deliberately a copy of `packages/engine/src/rng.ts`'s primitives rather than an import.
 * Importing the engine would break D18's boundary for the sake of thirty lines, and the two have
 * genuinely different jobs: that one has to be *fair* to a claim two players will argue about,
 * this one only has to be *fixed*.
 */

/** FNV-1a over the key string. Cheap, well-mixed enough to seed splitmix32, dependency-free. */
function fnv1a(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** splitmix32 finalizer. One call in, one well-distributed 32-bit word out. */
function splitmix32(x: number): number {
  let z = (x + 0x9e3779b9) >>> 0
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
  return (z ^ (z >>> 15)) >>> 0
}

/** A uniform integer in `[0, bound)`, rejection-sampled so the distribution is exactly flat. */
function below(seed: string, counter: number, bound: number): number {
  const limit = 0x100000000 - (0x100000000 % bound)
  for (let stream = 0; stream < 64; stream++) {
    const w = splitmix32(fnv1a(`${seed}|${counter}|${stream}`))
    if (w < limit) return w % bound
  }
  // Probability under 2^-64. Reaching here means the generator is broken, and a wrong-but-
  // plausible bracket is worse than a stop.
  throw new Error('bracket rng: rejection sampling failed to terminate')
}

/**
 * Fisher-Yates, seeded. Returns a new array; the input is untouched.
 *
 * Backwards from the end, which is the standard formulation and the one whose uniformity is easy
 * to check — the forwards variant with a full-range index is the classic subtly-biased bug.
 */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(seed, i, i + 1)
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}
