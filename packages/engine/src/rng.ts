import type { Actor } from '@banpick/types'

/**
 * Deterministic dice (spec §11 non-negotiable 1, D9).
 *
 * **Counter-based, not a stream.** The seed is written into the creation event once and every
 * draw is a pure function of `(seed, seq, actor, attempt)`. Nothing accumulates, so any single
 * roll can be evaluated without replaying the ones before it — which is the property that
 * makes Phase 5's log analysis tractable instead of a full replay per question.
 *
 * `attempt` is what makes `onTie: REROLL` replayable: a tied roll advances the attempt counter
 * rather than consuming hidden stream state, so the reroll is as reproducible as the original.
 */

/** FNV-1a over the key string. Cheap, well-mixed enough to seed splitmix32, and dependency-free. */
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

export interface RollKey {
  seed: string
  /** The event's append index — spec §5 makes `seq` double as the RNG counter key. */
  seq: number
  actor: Actor
  attempt: number
}

function word(key: RollKey, stream: number): number {
  return splitmix32(fnv1a(`${key.seed}|${key.seq}|${key.actor}|${key.attempt}|${stream}`))
}

/**
 * A uniform integer in `[1, sides]`.
 *
 * Rejection sampling rather than modulo: at `sides = 6`, modulo over 2^32 is biased by about
 * one part in 700 million, which nobody would ever notice — and which would also be a silent,
 * permanent, unfixable-after-the-fact property of every log the app ever writes. The rejection
 * loop costs nothing and means the dice are exactly fair, which is a claim worth being able to
 * make to two people arguing about a roll.
 */
export function rollDie(key: RollKey, sides: number): number {
  if (!Number.isInteger(sides) || sides < 1) {
    throw new RangeError(`rollDie: sides must be a positive integer, got ${sides}`)
  }
  const limit = 0x100000000 - (0x100000000 % sides)
  for (let stream = 0; stream < 64; stream++) {
    const w = word(key, stream)
    if (w < limit) return (w % sides) + 1
  }
  // 64 consecutive rejections has probability under 2^-64 at any practical `sides`. Reaching
  // here means the generator is broken, and a wrong-but-plausible die is worse than a stop.
  throw new Error('rollDie: rejection sampling failed to terminate')
}

/** `1d6` and friends. Returns the sum, which is what `resolve: HIGHEST` compares. */
export function rollDice(key: RollKey, count: number, sides: number): number {
  let total = 0
  for (let i = 0; i < count; i++) {
    total += rollDie({ ...key, attempt: key.attempt * 1000 + i }, sides)
  }
  return total
}
