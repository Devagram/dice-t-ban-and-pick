import {
  advance,
  buildBracket,
  champion,
  dispute,
  downstreamOf,
  drawn,
  isComplete,
  isEliminated,
  rederive,
  statusOf,
  views,
  voidSlot,
  type BracketState,
  type ResultEntry,
} from '@banpick/bracket'
import { describe, expect, it } from 'vitest'

import { build, entrants, favourite, playOut, sidesOf, slot, statusIn } from './helpers.js'

/**
 * **D38, D39 and D40, tested as the rules they are rather than as code paths.**
 *
 * Each of these was an owner's decision with a stated reason, and the reason is what the test
 * asserts: a dispute halts one branch and not the tournament; a correction re-derives rather than
 * patches; a reset is reachable only the one way that makes it fair.
 */

/** Plays the N=4 double-elimination bracket down to a grand final the losers side has reached. */
function toGrandFinal(reset = true): BracketState {
  let b = build(4, 'DOUBLE_ELIMINATION', { grandFinalReset: reset })
  b = advance(b, 'W1M1', 'e1') // e4 out to losers
  b = advance(b, 'W1M2', 'e2') // e3 out to losers
  b = advance(b, 'W2M1', 'e1') // e2 out to losers; e1 wins the winners bracket
  b = advance(b, 'L1M1', 'e4')
  b = advance(b, 'L2M1', 'e4') // e4 wins the losers bracket
  return b
}

describe('D40 — the grand final and its reset', () => {
  it('crowns the winners-bracket entrant outright when they win', () => {
    const b = advance(toGrandFinal(), 'GF', 'e1')
    // e1 has no losses; there is nothing left to decide.
    expect(isComplete(b)).toBe(true)
    expect(champion(b)).toBe('e1')
    expect(statusIn(b, 'GF2')).toBe('PENDING')
  })

  it('opens the reset when the losers-bracket entrant wins, and does not crown them yet', () => {
    const b = advance(toGrandFinal(), 'GF', 'e4')
    // Both now hold one loss. Crowning e4 here would eliminate e1 on a single defeat, which is
    // the whole thing double elimination promises not to do.
    expect(isComplete(b)).toBe(false)
    expect(champion(b)).toBeNull()
    expect(statusIn(b, 'GF2')).toBe('READY')
    expect(sidesOf(b, 'GF2')).toEqual(['e4', 'e1'])
  })

  it('is decided by the reset once it is played', () => {
    let b = advance(toGrandFinal(), 'GF', 'e4')
    b = advance(b, 'GF2', 'e1')
    expect(champion(b)).toBe('e1')
  })

  it('crowns the losers-bracket entrant on the spot when reset is off', () => {
    const b = advance(toGrandFinal(false), 'GF', 'e4')
    expect(champion(b)).toBe('e4')
    // The slot does not exist at all, rather than existing and being skipped.
    expect(b.slots.some((s) => s.id === 'GF2')).toBe(false)
  })

  it('is terminal — a reset cannot itself reset', () => {
    // The one way this format could fail to terminate. `GF2` routes nowhere by construction.
    const b = build(8)
    expect(slot(b, 'GF2').winnerTo).toBeNull()
    expect(slot(b, 'GF2').loserTo).toBeNull()
  })

  it('is off for single elimination, where there is no losers bracket to reset from', () => {
    expect(build(8, 'SINGLE_ELIMINATION', { grandFinalReset: true }).grandFinalReset).toBe(false)
  })
})

describe('D38 — a dispute halts one branch, not the tournament', () => {
  it('resolves nobody and routes nobody', () => {
    const b = dispute(advance(build(8), 'W1M1', 'e1'), 'W1M2')
    expect(statusIn(b, 'W1M2')).toBe('DISPUTED')
    // W2M1 needs both W1M1 and W1M2. One is disputed, so it waits.
    expect(statusIn(b, 'W2M1')).toBe('PENDING')
    // And the loser never dropped, so the losers slot fed by it waits too.
    expect(statusIn(b, 'L1M1')).toBe('PENDING')
  })

  it('leaves every other branch advancing', () => {
    let b = dispute(build(8), 'W1M1')
    b = advance(b, 'W1M3', 'e2')
    b = advance(b, 'W1M4', 'e3')
    // The other half of the bracket does not care that a semi-final is stuck.
    expect(statusIn(b, 'W2M2')).toBe('READY')
    expect(statusIn(b, 'L1M2')).toBe('READY')
  })

  it('is cleared by reporting a winner afterwards, because the log is append-only', () => {
    let b = dispute(build(8), 'W1M1')
    b = advance(b, 'W1M1', 'e1')
    expect(statusIn(b, 'W1M1')).toBe('DONE')
    // The dispute stays in the log. Phase 7's organizer resolution is exactly this append.
    expect(b.results.map((r) => r.type)).toEqual(['DISPUTE', 'WIN'])
  })
})

describe('a drawn match waits for a person', () => {
  /*
   * Not a defensive case. D21 makes 1.5–1.5 a legal terminal state whenever nothing is left to
   * play, and D36's Bo1 allows a tied single round outright — so any tournament using either mode
   * can produce a match with no winner, and a bracket cannot advance on that.
   */
  it('resolves nobody and routes nobody', () => {
    const b = drawn(build(8), 'W1M1')
    expect(statusIn(b, 'W1M1')).toBe('DRAWN')
    expect(statusIn(b, 'W2M1')).toBe('PENDING')
    expect(statusIn(b, 'L1M1')).toBe('PENDING')
  })

  it('is distinguishable from a dispute and from a void', () => {
    // All three resolve nobody; only the status tells the organizer what they are being asked to
    // decide. Folding a draw into either would ask them the wrong question.
    expect(statusIn(drawn(build(8), 'W1M1'), 'W1M1')).toBe('DRAWN')
    expect(statusIn(dispute(build(8), 'W1M1'), 'W1M1')).toBe('DISPUTED')
    expect(statusIn(voidSlot(build(8), 'W1M1'), 'W1M1')).toBe('VOIDED')
  })

  it('leaves the other half of the bracket advancing', () => {
    let b = drawn(build(8), 'W1M1')
    b = advance(b, 'W1M3', 'e2')
    b = advance(b, 'W1M4', 'e3')
    expect(statusIn(b, 'W2M2')).toBe('READY')
  })

  it('is cleared by a later result, because the log is append-only', () => {
    let b = drawn(build(8), 'W1M1')
    b = advance(b, 'W1M1', 'e1')
    expect(statusIn(b, 'W1M1')).toBe('DONE')
    expect(b.results.map((r) => r.type)).toEqual(['DRAWN', 'WIN'])
  })

  it('will not touch a slot that does not exist', () => {
    expect(() => drawn(build(8), 'nope')).toThrow(/no slot/)
  })
})

describe('D39 — a correction re-derives, and never patches', () => {
  it('is an append, so the earlier answer stays in the log', () => {
    let b = advance(build(8), 'W1M1', 'e1')
    b = advance(b, 'W1M1', 'e8')
    expect(sidesOf(b, 'W2M1')[0]).toBe('e8')
    expect(b.results).toHaveLength(2)
  })

  it('gives the same bracket whether folded or advanced incrementally', () => {
    // The equality D39's whole correction path rests on. Asserted directly rather than assumed.
    const played = playOut(build(8), favourite)
    const refolded = rederive(build(8), played.results)
    expect(refolded.slots.map((s) => statusOf(refolded, s))).toEqual(
      played.slots.map((s) => statusOf(played, s)),
    )
    expect(champion(refolded)).toBe(champion(played))
  })

  it('re-derives correctly from a corrected log, at every correction point', () => {
    const played = playOut(build(8), favourite)

    for (let i = 0; i < played.results.length; i++) {
      const entry = played.results[i]!
      if (entry.type !== 'WIN') continue

      // Flip result i to the other entrant, drop everything after it — which is what an organizer
      // correction leaves behind once the downstream matches are invalidated.
      const base = build(8)
      const upTo = played.results.slice(0, i) as ResultEntry[]
      const partial = rederive(base, upTo)
      const [a, b] = sidesOf(partial, entry.slotId)
      const other = entry.winner === a ? b : a
      if (other === null) continue

      const corrected = rederive(base, [...upTo, { ...entry, winner: other }])
      expect(champion(corrected), `corrected at ${entry.slotId}`).toBeNull()
      // And it plays on from there to exactly one champion.
      expect(champion(playOut(corrected, favourite))).not.toBeNull()
    }
  })

  it('names everything downstream of a slot, played or not', () => {
    const b = build(8)
    const downstream = downstreamOf(b, 'W1M1')
    // The winner's path and the loser's path both count — a correction invalidates both.
    expect(downstream).toContain('W2M1')
    expect(downstream).toContain('L1M1')
    expect(downstream).toContain('GF')
    expect(downstream).not.toContain('W1M2')
  })

  it('voids a slot without resolving it', () => {
    const b = voidSlot(advance(build(8), 'W1M1', 'e1'), 'W1M1')
    expect(statusIn(b, 'W1M1')).toBe('VOIDED')
    expect(statusIn(b, 'W2M1')).toBe('PENDING')
    // Not automatically re-offered: whether a voided match is re-run is a decision for a person.
    expect(statusIn(b, 'W1M1')).not.toBe('READY')
  })
})

describe('reading a bracket', () => {
  it('views every slot, which is what the graphic renders', () => {
    const b = advance(build(8), 'W1M1', 'e1')
    const all = views(b)
    expect(all).toHaveLength(b.slots.length)
    expect(all.map((v) => v.slot.id)).toEqual(b.slots.map((s) => s.id))

    const first = all.find((v) => v.slot.id === 'W1M1')!
    expect(first).toMatchObject({ status: 'DONE', entrants: ['e1', 'e8'], winner: 'e1' })
    // A pending slot names nobody rather than naming a placeholder.
    expect(all.find((v) => v.slot.id === 'W2M1')!.entrants).toEqual(['e1', null])
  })

  it('knows who is out, on one loss or two', () => {
    const single = advance(build(8, 'SINGLE_ELIMINATION'), 'W1M1', 'e1')
    expect(isEliminated(single, 'e8')).toBe(true)
    expect(isEliminated(single, 'e1')).toBe(false)

    let double = advance(build(8), 'W1M1', 'e1')
    // One loss drops you to the losers bracket, which is not elimination.
    expect(isEliminated(double, 'e8')).toBe(false)
    double = advance(double, 'W1M2', 'e4')
    double = advance(double, 'L1M1', 'e8')
    expect(isEliminated(double, 'e5')).toBe(true)
    expect(isEliminated(double, 'e8')).toBe(false)
  })
})

describe('purity', () => {
  it('never mutates the bracket it was given', () => {
    const before = build(8)
    const snapshot = JSON.stringify(before)
    advance(before, 'W1M1', 'e1')
    dispute(before, 'W1M2')
    voidSlot(before, 'W1M3')
    downstreamOf(before, 'W1M1')
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('gives byte-identical output for identical input', () => {
    const a = playOut(build(8), favourite)
    const b = playOut(build(8), favourite)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('seeds randomly but reproducibly', () => {
    const opts = { seeding: 'RANDOM' as const, seedingSeed: 'draw-2026-08-15' }
    const a = buildBracket('SINGLE_ELIMINATION', entrants(16), opts)
    const b = buildBracket('SINGLE_ELIMINATION', entrants(16), opts)
    expect(a.entrants.map((e) => e.entrantId)).toEqual(b.entrants.map((e) => e.entrantId))

    // A different seed gives a different draw, or the seeding is not doing anything.
    const c = buildBracket('SINGLE_ELIMINATION', entrants(16), { ...opts, seedingSeed: 'other' })
    expect(c.entrants.map((e) => e.entrantId)).not.toEqual(a.entrants.map((e) => e.entrantId))

    // And it is a permutation, not a subset.
    expect([...a.entrants.map((e) => e.entrantId)].sort()).toEqual(
      entrants(16)
        .map((e) => e.entrantId)
        .sort(),
    )
  })
})

describe('seeding modes', () => {
  it('takes the organizer order as given by default', () => {
    expect(build(4).entrants.map((e) => e.seed)).toEqual([1, 2, 3, 4])
  })

  it('honours a manual seeding, and refuses a broken one', () => {
    const manual = entrants(4).map((e, i) => ({ ...e, seed: 4 - i }))
    const b = buildBracket('SINGLE_ELIMINATION', manual, { seeding: 'MANUAL' })
    expect(b.entrants.map((e) => e.entrantId)).toEqual(['e4', 'e3', 'e2', 'e1'])

    const clash = entrants(4).map((e) => ({ ...e, seed: 1 }))
    expect(() => buildBracket('SINGLE_ELIMINATION', clash, { seeding: 'MANUAL' })).toThrow(
      /claimed by more than one/,
    )
    const outside = entrants(4).map((e, i) => ({ ...e, seed: i === 0 ? 99 : i + 1 }))
    expect(() => buildBracket('SINGLE_ELIMINATION', outside, { seeding: 'MANUAL' })).toThrow(
      /outside 1\.\.4/,
    )
  })
})

describe('refusing an impossible result', () => {
  it('will not advance a slot whose sides are unknown', () => {
    expect(() => advance(build(8), 'W2M1', 'e1')).toThrow(/PENDING/)
  })

  it('will not advance a walkover', () => {
    // The structure decided it. A reported result would be a record of a game nobody played.
    expect(() => advance(build(5, 'SINGLE_ELIMINATION'), 'W1M1', 'e1')).toThrow(/walkover/)
  })

  it('will not crown somebody who is not in the slot', () => {
    expect(() => advance(build(8), 'W1M1', 'e5')).toThrow(/not in slot/)
  })

  it('will not touch a slot that does not exist', () => {
    expect(() => advance(build(8), 'W9M9', 'e1')).toThrow(/no slot/)
    expect(() => dispute(build(8), 'nope')).toThrow(/no slot/)
    expect(() => voidSlot(build(8), 'nope')).toThrow(/no slot/)
  })

  it('fails loudly on a malformed bracket rather than resolving it to nobody', () => {
    /*
     * A ref naming a slot that does not exist is a bug in `buildBracket`, not a state a
     * tournament can reach — so `slotById` throws instead of returning "unknown". Constructed by
     * hand here because nothing else can produce it, and asserted because a silent UNKNOWN would
     * present as a bracket that quietly stops advancing with no explanation anywhere.
     */
    const broken = build(8)
    const mangled = {
      ...broken,
      slots: broken.slots.map((s) =>
        s.id === 'W2M1'
          ? { ...s, entrants: [{ from: 'WINNER_OF' as const, slotId: 'NOPE' }, s.entrants[1]] }
          : s,
      ),
    } as typeof broken
    expect(() => statusOf(mangled, slot(mangled, 'W2M1'))).toThrow(/malformed/)
  })
})
