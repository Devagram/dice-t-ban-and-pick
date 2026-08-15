import { describe, expect, it } from 'vitest'
import { baseMode, legalActions, reduce } from '@banpick/engine'
import type { RoundOutcome } from '@banpick/types'

import { apply, expectRejected, playMatch, startMatch } from './helpers.js'

/**
 * **D33 — correcting a round after the fact.**
 *
 * D15's undo covers the result you just entered and shuts as soon as the next round starts. This
 * covers the one you notice later, which is the mistake that actually survives to matter.
 *
 * The delicate part is not the score arithmetic, it is where the cursor ends up: changing an old
 * result can make a round live that `stopWhenDecided` skipped, or make D30's overtime owed. These
 * tests are mostly about the cursor landing somewhere the match can actually be played from — see
 * the note in `amendResult` for why that needs no rewinding, which a mutation test settled after
 * the comment there claimed the opposite.
 */

const state = (results: RoundOutcome[], draftCount: 3 | 4 = 4) =>
  playMatch(startMatch({ mode: baseMode, draftCount }), results)

const amend = (
  s: ReturnType<typeof startMatch>,
  seat: 'A' | 'B',
  roundIndex: 0 | 1 | 2 | 3,
  outcome: RoundOutcome,
) => apply(s, seat, { type: 'AMEND_RESULT', roundIndex, outcome, amendedBy: seat })

describe('what it changes', () => {
  it('moves the score and re-decides the match', () => {
    const final = amend(state(['A', 'B', 'A']), 'A', 0, 'B')

    expect(final.rounds[0]!.result).toBe('B')
    expect(final.seats.A.score).toBe(1)
    expect(final.seats.B.score).toBe(2)
    // The winner is recomputed rather than left at whatever it was when the match completed.
    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('B')
  })

  it('handles a tie in both directions, without half-points drifting', () => {
    let s = amend(state(['A', 'B', 'A']), 'B', 0, 'TIE')
    expect(s.seats.A.score).toBe(1.5)
    expect(s.seats.B.score).toBe(1.5)

    // And back again — the reversal has to be exact, not approximately exact.
    s = amend(s, 'B', 0, 'A')
    expect(s.seats.A.score).toBe(2)
    expect(s.seats.B.score).toBe(1)
  })

  it('brings back a round that stopWhenDecided had skipped', () => {
    // 2–0 after two rounds, so round 2 was never played.
    const decided = state(['A', 'A', 'A'])
    expect(decided.rounds[2]!.result).toBeNull()

    const reopened = amend(decided, 'B', 0, 'B')
    expect(reopened.status).toBe('IN_PROGRESS')
    expect(reopened.outcome).toBeNull()
    // The cursor has to land *in* round 2 rather than at the end of the program, or the match
    // completes without playing the round it just made necessary.
    const mod = reopened.mode.program[reopened.cursor]
    expect(mod?.roundIndex).toBe(2)
  })

  it('owes overtime when the correction levels the match (D30)', () => {
    const decided = state(['TIE', 'TIE', 'A'])
    expect(decided.status).toBe('COMPLETE')

    const level = amend(decided, 'A', 2, 'TIE')
    expect(level.seats.A.score).toBe(1.5)
    expect(level.seats.B.score).toBe(1.5)
    // Regulation is level and each seat still holds a character, so the decider is now owed.
    expect(level.status).toBe('IN_PROGRESS')
    expect(level.mode.program[level.cursor]?.roundIndex).toBe(3)
  })

  it('leaves a draw standing where there is nothing left to play', () => {
    const drawn = state(['TIE', 'TIE', 'A'], 3)
    const level = amend(drawn, 'A', 2, 'TIE')

    // At draftCount 3 every character is spent, so D21's draw is still the honest answer.
    expect(level.status).toBe('COMPLETE')
    expect(level.outcome).toBe('DRAW')
  })
})

describe('what it refuses', () => {
  it('refuses a round that was never reported', () => {
    const s = state(['A', 'A', 'A']) // round 2 skipped
    expect(
      expectRejected(
        reduce(s, {
          v: 1,
          seq: s.log.length,
          tag: 'amend',
          actor: 'A',
          payload: { type: 'AMEND_RESULT', roundIndex: 2, outcome: 'B', amendedBy: 'A' },
        }),
      ).code,
    ).toBe('NOTHING_TO_UNDO')
  })

  it('refuses an amendment to the value already recorded', () => {
    const s = state(['A', 'B', 'A'])
    // Not an error worth its own code, but appending it would put a correction in the log that
    // corrected nothing — and the log is the record.
    expect(
      expectRejected(
        reduce(s, {
          v: 1,
          seq: s.log.length,
          tag: 'amend',
          actor: 'A',
          payload: { type: 'AMEND_RESULT', roundIndex: 0, outcome: 'A', amendedBy: 'A' },
        }),
      ).code,
    ).toBe('DUPLICATE_COMMIT')
  })

  it('refuses a tie in overtime, which exists to break one', () => {
    const s = state(['TIE', 'TIE', 'TIE', 'A'])
    expect(s.rounds[3]!.result).toBe('A')
    expect(
      expectRejected(
        reduce(s, {
          v: 1,
          seq: s.log.length,
          tag: 'amend',
          actor: 'B',
          payload: { type: 'AMEND_RESULT', roundIndex: 3, outcome: 'TIE', amendedBy: 'B' },
        }),
      ).code,
    ).toBe('ILLEGAL_OPTION')
  })
})

describe('what it offers', () => {
  it("offers every played round, with that round's own outcomes", () => {
    const s = state(['TIE', 'TIE', 'TIE', 'A'])
    const amendable = legalActions(s, 'A').find((a) => a.type === 'AMEND_RESULT')!

    expect(amendable.rounds.map((r) => r.roundIndex)).toEqual([0, 1, 2, 3])
    // Regulation takes a tie; D30's overtime does not, and the client is not allowed to be the
    // thing that knows the difference (§11 non-negotiable 4).
    expect(amendable.rounds[0]!.outcomes).toEqual(['A', 'B', 'TIE'])
    expect(amendable.rounds[3]!.outcomes).toEqual(['A', 'B'])
    expect(amendable.rounds[3]!.current).toBe('A')
  })

  it('offers nothing before any round has been played', () => {
    const fresh = startMatch({ mode: baseMode, draftCount: 4 })
    expect(legalActions(fresh, 'A').some((a) => a.type === 'AMEND_RESULT')).toBe(false)
  })
})
