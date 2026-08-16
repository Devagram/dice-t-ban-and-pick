import { shuffle } from './rng.js'
import type { Entrant, SeedingMode } from './types.js'

/** The smallest power of two that can hold `n` entrants. `n <= 1` still yields a 1-slot bracket. */
export function bracketSize(n: number): number {
  let size = 1
  while (size < n) size *= 2
  return size
}

/** `log2` of a power of two, as an integer. The number of winners-bracket rounds. */
export function roundsFor(size: number): number {
  let rounds = 0
  let s = size
  while (s > 1) {
    s /= 2
    rounds++
  }
  return rounds
}

/**
 * The standard bracket seeding order: which seed sits at each position of round one.
 *
 * Built by repeated reflection, which is the property that matters rather than the numbers it
 * happens to produce: at every doubling, each existing seed `d` is paired with `length - d`, so
 * the strongest meets the weakest, and 1 and 2 can only meet in the final. Written this way
 * rather than as a lookup table because the invariant is checkable by eye and a table is not.
 *
 *     size 2 → [1, 2]
 *     size 4 → [1, 4, 2, 3]              pairs (1,4) (2,3)
 *     size 8 → [1, 8, 4, 5, 2, 7, 3, 6]  pairs (1,8) (4,5) (2,7) (3,6)
 */
export function seedOrder(size: number): number[] {
  let order = [1]
  while (order.length < size) {
    const length = order.length * 2 + 1
    const next: number[] = []
    for (const d of order) {
      next.push(d, length - d)
    }
    order = next
  }
  return order
}

/**
 * Assigns each entrant a seed, per the chosen mode.
 *
 * Returns a new array sorted by seed, so everything downstream can index by `seed - 1` without
 * re-sorting and without caring which mode produced it.
 *
 * - `AS_ENTERED` — the organizer's order is the seeding. The default, because for a group of
 *   friends the list was probably typed in a meaningful order and pretending otherwise is worse.
 * - `MANUAL` — each entrant's declared `seed` is used as given.
 * - `RANDOM` — shuffled against `seedingSeed`, so the draw is reproducible from the creation
 *   event rather than lost the first time the object hibernates.
 */
export function assignSeeds(
  entrants: readonly Entrant[],
  mode: SeedingMode,
  seedingSeed: string,
): Entrant[] {
  if (mode === 'MANUAL') {
    const seen = new Set<number>()
    for (const e of entrants) {
      if (!Number.isInteger(e.seed) || e.seed < 1 || e.seed > entrants.length) {
        throw new RangeError(
          `MANUAL seeding: '${e.displayName}' has seed ${e.seed}, outside 1..${entrants.length}`,
        )
      }
      if (seen.has(e.seed)) {
        throw new RangeError(`MANUAL seeding: seed ${e.seed} is claimed by more than one entrant`)
      }
      seen.add(e.seed)
    }
    return [...entrants].sort((a, b) => a.seed - b.seed)
  }

  const ordered = mode === 'RANDOM' ? shuffle(entrants, seedingSeed) : [...entrants]
  return ordered.map((e, i) => ({ ...e, seed: i + 1 }))
}
