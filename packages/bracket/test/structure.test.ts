import { bracketSize, buildBracket, MAX_ENTRANTS, seedOrder } from '@banpick/bracket'
import { describe, expect, it } from 'vitest'

import { build, entrants, idsOf, sidesOf, slot } from './helpers.js'

/**
 * **The shape, before anything is played.**
 *
 * Asserted against hand-written expected structures rather than against whatever the code
 * produces: a structural test that reads the implementation back to itself proves only that the
 * code is deterministic. If a published bracket for N entrants disagrees with these, these are
 * wrong.
 */

describe('seeding order', () => {
  it('reflects at every doubling, so 1 and 2 can only meet in the final', () => {
    expect(seedOrder(2)).toEqual([1, 2])
    expect(seedOrder(4)).toEqual([1, 4, 2, 3])
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6])
    expect(seedOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11])
  })

  it('pairs every seed with its complement', () => {
    for (const size of [2, 4, 8, 16, 32]) {
      const order = seedOrder(size)
      expect(order).toHaveLength(size)
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1),
      )
      for (let i = 0; i < size; i += 2) {
        expect(order[i]! + order[i + 1]!).toBe(size + 1)
      }
    }
  })

  it('rounds a field up to the next power of two', () => {
    expect([2, 3, 4, 5, 8, 9, 16, 17, 32].map(bracketSize)).toEqual([2, 4, 4, 8, 8, 16, 16, 32, 32])
  })
})

describe('single elimination', () => {
  it('has the rounds and matches an 8-entrant bracket should', () => {
    const b = build(8, 'SINGLE_ELIMINATION')
    expect(idsOf(b)).toEqual(['W1M1', 'W1M2', 'W1M3', 'W1M4', 'W2M1', 'W2M2', 'W3M1'])
  })

  it('seeds round one 1v8, 4v5, 2v7, 3v6', () => {
    const b = build(8, 'SINGLE_ELIMINATION')
    expect(sidesOf(b, 'W1M1')).toEqual(['e1', 'e8'])
    expect(sidesOf(b, 'W1M2')).toEqual(['e4', 'e5'])
    expect(sidesOf(b, 'W1M3')).toEqual(['e2', 'e7'])
    expect(sidesOf(b, 'W1M4')).toEqual(['e3', 'e6'])
  })

  it('routes winners forward and nobody anywhere else', () => {
    const b = build(8, 'SINGLE_ELIMINATION')
    expect(slot(b, 'W1M1').winnerTo).toBe('W2M1')
    expect(slot(b, 'W1M2').winnerTo).toBe('W2M1')
    expect(slot(b, 'W2M2').winnerTo).toBe('W3M1')
    expect(slot(b, 'W3M1').winnerTo).toBeNull()
    expect(b.slots.every((s) => s.loserTo === null)).toBe(true)
  })
})

describe('byes', () => {
  it('go to the top seeds', () => {
    // 5 of 8: seeds 6, 7 and 8 do not exist, and `seedOrder` pairs them with 3, 2 and 1.
    const b = build(5, 'SINGLE_ELIMINATION')
    expect(sidesOf(b, 'W1M1')).toEqual(['e1', null])
    expect(sidesOf(b, 'W1M2')).toEqual(['e4', 'e5'])
    expect(sidesOf(b, 'W1M3')).toEqual(['e2', null])
    expect(sidesOf(b, 'W1M4')).toEqual(['e3', null])
  })

  it('resolve without a result, and are not READY', () => {
    const b = build(5, 'SINGLE_ELIMINATION')
    // A walkover is decided by the structure. Recording a result for it would make it
    // indistinguishable in the log from a game somebody actually played.
    expect(sidesOf(b, 'W2M1')).toEqual(['e1', null])
    expect(b.results).toHaveLength(0)
  })

  it('never produce a phantom opponent at any size from 2 to 32', () => {
    for (let n = 2; n <= MAX_ENTRANTS; n++) {
      const b = build(n, 'SINGLE_ELIMINATION')
      const round1 = b.slots.filter((s) => s.round === 1)
      const named = round1.flatMap((s) =>
        s.entrants.filter((e) => e.from === 'ENTRANT').map((e) => e.entrantId),
      )
      // Everyone appears exactly once in round one, and nobody appears who was not entered.
      expect([...new Set(named)]).toHaveLength(n)
      expect(named).toHaveLength(n)
    }
  })
})

describe('double elimination structure', () => {
  it('has 2(k-1) losers rounds, with the widths the format requires', () => {
    const shapes: [n: number, expected: Record<string, number>][] = [
      [4, { L1: 1, L2: 1 }],
      [8, { L1: 2, L2: 2, L3: 1, L4: 1 }],
      [16, { L1: 4, L2: 4, L3: 2, L4: 2, L5: 1, L6: 1 }],
      [32, { L1: 8, L2: 8, L3: 4, L4: 4, L5: 2, L6: 2, L7: 1, L8: 1 }],
    ]
    for (const [n, expected] of shapes) {
      const b = build(n)
      const byRound: Record<string, number> = {}
      for (const s of b.slots.filter((x) => x.side === 'LOSERS')) {
        byRound[`L${s.round}`] = (byRound[`L${s.round}`] ?? 0) + 1
      }
      expect(byRound, `n=${n}`).toEqual(expected)
    }
  })

  it('drops each winners round into the losers round that receives it', () => {
    const b = build(8)
    // W1 → L1, W2 → L2, W3 (the winners final) → L4.
    expect(slot(b, 'W1M1').loserTo).toBe('L1M1')
    expect(slot(b, 'W1M3').loserTo).toBe('L1M2')
    expect(slot(b, 'W2M1').loserTo).toBe('L2M2')
    expect(slot(b, 'W3M1').loserTo).toBe('L4M1')
  })

  it('reverses the drop-in order in a major round, which is the anti-rematch rule', () => {
    const b = build(8)
    // L1M1 holds the losers of W1M1 and W1M2; W2M1 holds their winners. Straight placement would
    // put the L1M1 winner opposite somebody from that same pair. Reversed, it cannot.
    expect(slot(b, 'L2M1').entrants).toEqual([
      { from: 'WINNER_OF', slotId: 'L1M1' },
      { from: 'LOSER_OF', slotId: 'W2M2' },
    ])
    expect(slot(b, 'L2M2').entrants).toEqual([
      { from: 'WINNER_OF', slotId: 'L1M2' },
      { from: 'LOSER_OF', slotId: 'W2M1' },
    ])
  })

  it('ends at a grand final fed by both brackets', () => {
    const b = build(8)
    expect(slot(b, 'GF').entrants).toEqual([
      { from: 'WINNER_OF', slotId: 'W3M1' },
      { from: 'WINNER_OF', slotId: 'L4M1' },
    ])
  })

  it('handles two entrants, where there is no losers bracket at all', () => {
    // 2(k-1) = 0 rounds. The one loser goes straight to the final, which makes this a first-to-two
    // rather than a special case anybody had to write.
    const b = build(2)
    expect(b.slots.filter((s) => s.side === 'LOSERS')).toHaveLength(0)
    expect(slot(b, 'W1M1').loserTo).toBe('GF')
    expect(slot(b, 'GF').entrants).toEqual([
      { from: 'WINNER_OF', slotId: 'W1M1' },
      { from: 'LOSER_OF', slotId: 'W1M1' },
    ])
  })
})

describe('refusals', () => {
  it('rejects a field below two or above the D42 cap', () => {
    expect(() => buildBracket('SINGLE_ELIMINATION', entrants(1))).toThrow(RangeError)
    expect(() => buildBracket('SINGLE_ELIMINATION', entrants(33))).toThrow(/at most 32/)
  })

  it('rejects duplicate entrant ids', () => {
    const dupes = entrants(4)
    dupes[3]!.entrantId = dupes[0]!.entrantId
    expect(() => buildBracket('SINGLE_ELIMINATION', dupes)).toThrow(/distinct entrantId/)
  })
})
