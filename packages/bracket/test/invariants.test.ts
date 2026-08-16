import {
  advance,
  champion,
  isComplete,
  lossesOf,
  MAX_ENTRANTS,
  readySlots,
  viewOf,
  type BracketState,
  type EntrantId,
} from '@banpick/bracket'
import { describe, expect, it } from 'vitest'

import { build, favourite, playOut, underdog } from './helpers.js'

/**
 * **The properties that make a bracket correct, checked exhaustively where that is possible.**
 *
 * A structural test says the drawing is the shape someone expected. These say the thing the
 * format promises: nobody goes home early, somebody wins, and it ends. At N=4 and N=8 every
 * possible result sequence is played out, which is 2^(matches) paths — small enough to enumerate
 * and therefore not a sample.
 */

/**
 * Every distinct way a bracket can play out, as a list of finished states.
 *
 * N=8 double elimination is 15 slots, so this is up to 2^15 terminal states — genuinely
 * exhaustive rather than a sample, and about three seconds. Computed **once** at module scope and
 * shared by the assertions below, because re-enumerating per test turned a 3-second suite into a
 * 15-second one for no extra coverage.
 */
function everyOutcome(bracket: BracketState, limit = 40000): BracketState[] {
  const finished: BracketState[] = []
  const stack: BracketState[] = [bracket]

  while (stack.length > 0) {
    if (finished.length > limit) throw new Error(`more than ${limit} outcomes; narrow the case`)
    const current = stack.pop()!
    if (isComplete(current)) {
      finished.push(current)
      continue
    }
    const ready = readySlots(current)
    if (ready.length === 0) {
      throw new Error('stalled with no champion and nothing ready')
    }
    // Branch on the first ready slot only. Every ordering of independent slots reaches the same
    // set of terminal states, so enumerating orderings as well would multiply the work without
    // covering anything new.
    const next = ready[0]!
    const [a, b] = viewOf(current, next).entrants
    for (const winner of [a!, b!]) stack.push(advance(current, next.id, winner))
  }

  return finished
}

const DOUBLE_4 = everyOutcome(build(4))
const DOUBLE_8 = everyOutcome(build(8))

/**
 * Losses for everybody, in one walk of the slots.
 *
 * `lossesOf` is the readable way to ask about one entrant and the right shape for the public API.
 * Called once per entrant across 32768 outcomes it re-walks the whole bracket eight times over,
 * which is what pushed this file past the default timeout. Same answer, one pass.
 */
function lossTally(outcome: BracketState): Map<EntrantId, number> {
  const tally = new Map<EntrantId, number>()
  for (const e of outcome.entrants) tally.set(e.entrantId, 0)
  for (const slot of outcome.slots) {
    const view = viewOf(outcome, slot)
    if (view.winner === null) continue
    const [a, b] = view.entrants
    if (a === null || b === null) continue
    const loser = view.winner === a ? b : a
    tally.set(loser, (tally.get(loser) ?? 0) + 1)
  }
  return tally
}

describe('single elimination', () => {
  it('produces exactly one champion at every size from 2 to 32', () => {
    for (let n = 2; n <= MAX_ENTRANTS; n++) {
      const done = playOut(build(n, 'SINGLE_ELIMINATION'), favourite)
      expect(champion(done), `n=${n}`).toBe('e1')
    }
  })

  it('eliminates on one loss, and the champion has none', () => {
    for (const outcome of everyOutcome(build(8, 'SINGLE_ELIMINATION'))) {
      const winner = champion(outcome)!
      expect(lossesOf(outcome, winner)).toBe(0)
      for (const e of outcome.entrants) {
        if (e.entrantId !== winner) expect(lossesOf(outcome, e.entrantId)).toBe(1)
      }
    }
  })
})

describe('double elimination', () => {
  it('produces exactly one champion at every size from 2 to 32', () => {
    for (let n = 2; n <= MAX_ENTRANTS; n++) {
      for (const pick of [favourite, underdog]) {
        const done = playOut(build(n), pick)
        expect(champion(done), `n=${n}`).not.toBeNull()
      }
    }
  })

  it('never eliminates anybody on fewer than two losses — N=4, every result sequence', () => {
    expect(DOUBLE_4.length).toBeGreaterThan(0)
    for (const outcome of DOUBLE_4) {
      const winner = champion(outcome)!
      for (const e of outcome.entrants) {
        if (e.entrantId === winner) continue
        // The whole promise of the format. One loss is a setback; two is elimination.
        expect(lossesOf(outcome, e.entrantId), `${e.entrantId} in ${trace(outcome)}`).toBe(2)
      }
    }
  })

  // Exhaustive over 2^15 terminal states, so seconds rather than milliseconds. The default 5s
  // is vitest's, not a budget anyone chose for this.
  it(
    'never eliminates anybody on fewer than two losses — N=8, every result sequence',
    { timeout: 60_000 },
    () => {
      for (const outcome of DOUBLE_8) {
        const winner = champion(outcome)!
        const tally = lossTally(outcome)
        for (const e of outcome.entrants) {
          if (e.entrantId === winner) continue
          expect(tally.get(e.entrantId), `${e.entrantId} in ${trace(outcome)}`).toBe(2)
        }
      }
    },
  )

  it('lets the champion lose at most once', { timeout: 60_000 }, () => {
    for (const outcome of DOUBLE_8) {
      const winner = champion(outcome)!
      // Two losses would mean the eventual champion was eliminated and kept playing.
      expect(lossTally(outcome).get(winner), trace(outcome)).toBeLessThanOrEqual(1)
    }
  })

  it('agrees with the public lossesOf on a sample', () => {
    // `lossTally` is a test-local shortcut; this keeps it honest against the shipped function.
    for (const outcome of DOUBLE_8.slice(0, 50)) {
      const tally = lossTally(outcome)
      for (const e of outcome.entrants) {
        expect(tally.get(e.entrantId)).toBe(lossesOf(outcome, e.entrantId))
      }
    }
  })

  it('terminates from every position — no result sequence stalls', () => {
    // `everyOutcome` throws on a stall, so reaching the assertion is the assertion. Stated
    // explicitly because it is G14's argument one layer up: a format that cannot finish is the
    // same failure as a match that cannot, and it arrives in front of real people.
    expect(DOUBLE_4.length).toBeGreaterThan(0)
    expect(DOUBLE_8.length).toBeGreaterThan(0)
  })
})

describe('the first major losers round never rematches', () => {
  /*
   * The case the reversal rule provably fixes, and the one that actually occurs at small sizes:
   * L2Mm pairs the L1Mm winner against a W2 loser. Straight placement can put two people who
   * just played each other in W1 back together immediately.
   */
  it('holds for every result sequence at N=8', { timeout: 60_000 }, () => {
    for (const outcome of DOUBLE_8) {
      const played = new Map<string, string[]>()
      for (const slot of outcome.slots) {
        const view = viewOf(outcome, slot)
        const [a, b] = view.entrants
        if (a === null || b === null) continue
        if (slot.side === 'LOSERS' && slot.round === 2) {
          const earlier = played.get(pairKey(a, b))
          expect(earlier, `${a} v ${b} in ${slot.id} repeats ${earlier?.join(',')}`).toBeUndefined()
        }
        const key = pairKey(a, b)
        played.set(key, [...(played.get(key) ?? []), slot.id])
      }
    }
  })
})

const pairKey = (a: EntrantId, b: EntrantId): string => [a, b].sort().join('|')

/** A compact record of who won what, for a failure message worth reading. */
function trace(bracket: BracketState): string {
  return bracket.results
    .map((r) => (r.type === 'WIN' ? `${r.slotId}:${r.winner}` : r.slotId))
    .join(' ')
}
