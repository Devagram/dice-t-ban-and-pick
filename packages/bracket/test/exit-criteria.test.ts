import {
  advance,
  champion,
  isComplete,
  readySlots,
  statusOf,
  viewOf,
  type BracketState,
} from '@banpick/bracket'
import { describe, expect, it } from 'vitest'

import { build } from './helpers.js'

/**
 * **Phase 1's exit criterion, written as the thing it says.**
 *
 * "A full 8-entrant double-elimination tournament can be played out in a unit test with no
 * worker, no DO, and no network."
 *
 * Kept as its own file rather than folded into the invariant sweeps, because it is not a property
 * check — it is the readable demonstration that the package does the job, and the one a reviewer
 * should be able to follow end to end without knowing anything about the rest of the repo.
 */

describe('the Phase 1 exit criterion', () => {
  it('plays a whole 8-entrant double-elimination tournament, in memory', () => {
    let b: BracketState = build(8)

    // Round one of the winners bracket. Seeded 1v8, 4v5, 2v7, 3v6.
    b = advance(b, 'W1M1', 'e1')
    b = advance(b, 'W1M2', 'e5') // an upset: the 5 seed knocks out the 4
    b = advance(b, 'W1M3', 'e2')
    b = advance(b, 'W1M4', 'e3')

    // The four losers have dropped into L1, paired in match order.
    expect(viewOf(b, slotOf(b, 'L1M1')).entrants).toEqual(['e8', 'e4'])
    expect(viewOf(b, slotOf(b, 'L1M2')).entrants).toEqual(['e7', 'e6'])

    b = advance(b, 'W2M1', 'e1')
    b = advance(b, 'W2M2', 'e2')
    b = advance(b, 'L1M1', 'e4')
    b = advance(b, 'L1M2', 'e6')

    // D37's anti-rematch rule, visible: e5 lost W2M1 and meets the *other* half's survivor.
    expect(viewOf(b, slotOf(b, 'L2M1')).entrants).toEqual(['e4', 'e3'])
    expect(viewOf(b, slotOf(b, 'L2M2')).entrants).toEqual(['e6', 'e5'])

    b = advance(b, 'L2M1', 'e4')
    b = advance(b, 'L2M2', 'e5')
    b = advance(b, 'W3M1', 'e1') // e1 wins the winners bracket; e2 drops to the losers final
    b = advance(b, 'L3M1', 'e5')
    expect(viewOf(b, slotOf(b, 'L4M1')).entrants).toEqual(['e5', 'e2'])
    b = advance(b, 'L4M1', 'e2') // e2 comes back to reach the grand final

    // Grand final: e1 with no losses, e2 with one.
    expect(viewOf(b, slotOf(b, 'GF')).entrants).toEqual(['e1', 'e2'])
    expect(isComplete(b)).toBe(false)

    // D40 — e2 wins from the losers side, so it is not over. Both now have one loss.
    b = advance(b, 'GF', 'e2')
    expect(isComplete(b)).toBe(false)
    expect(statusOf(b, slotOf(b, 'GF2'))).toBe('READY')

    b = advance(b, 'GF2', 'e2')
    expect(isComplete(b)).toBe(true)
    expect(champion(b)).toBe('e2')
    expect(readySlots(b)).toHaveLength(0)

    // Fifteen slots, every one of them accounted for.
    const statuses = b.slots.map((s) => statusOf(b, s))
    expect(statuses.filter((s) => s === 'DONE')).toHaveLength(15)
    expect(statuses.filter((s) => s === 'PENDING' || s === 'READY')).toHaveLength(0)
  })
})

function slotOf(bracket: BracketState, id: string) {
  const found = bracket.slots.find((s) => s.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}
