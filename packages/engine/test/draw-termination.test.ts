import { describe, expect, it } from 'vitest'
import { baseMode, isDecided, legalActions, reduce } from '@banpick/engine'
import type { RoundOutcome } from '@banpick/types'

import { apply, currentAction, expectRejected, playMatch, startMatch } from './helpers.js'

/**
 * Phase 1 gate — **draw termination.**
 *
 * This replaces the delivery plan's original tie gate, which asserted "three consecutive tied
 * rounds under `COMPENSATION` terminate at `FIRST_TO_2`". D21 cut `COMPENSATION` and never
 * shipped `FIRST_TO_2`, so that test described rules that do not exist. What ships is:
 *
 *     onTie:    { scoring: HALF_POINT, consumesCharacters: true }
 *     match:    { resolution: ALWAYS_3_ROUNDS, stopWhenDecided: true }
 *     overtime: { enabled: false }
 *
 * and **1.5–1.5 is a legal terminal state: the match is a draw.**
 *
 * §13's termination validator exists to keep that table to one row. Note in passing why
 * `HALF_POINT + FIRST_TO_2` is not offered: it deadlocks at 1.5–1.5 with an empty pool.
 */

describe('HALF_POINT scoring (D21)', () => {
  it('awards half a point to each seat on a tie, and spends both characters (D6)', () => {
    // At 3, so the scoring can be observed without D30's overtime deciding the level match.
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), ['TIE', 'A', 'B'])

    expect(final.rounds[0]!.result).toBe('TIE')
    // 0.5 + 1 + 0 for A; 0.5 + 0 + 1 for B.
    expect(final.seats.A.score).toBe(1.5)
    expect(final.seats.B.score).toBe(1.5)

    // D6 — a tie consumes characters. It is what makes HALF_POINT the natural default and
    // what keeps `consumed` monotonic.
    for (const seat of ['A', 'B'] as const) {
      expect(final.seats[seat].slots.value.filter((s) => s.consumed)).toHaveLength(3)
    }
  })

  it('ends 1.5–1.5 as a DRAW when there is nothing left to play', () => {
    // D21's terminal state, now reachable only at 3 — see D30 and the overtime suite.
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), ['TIE', 'TIE', 'TIE'])

    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('DRAW')
    expect(final.seats.A.score).toBe(1.5)
    expect(final.seats.B.score).toBe(1.5)
    expect(final.rounds.map((r) => r.result)).toEqual(['TIE', 'TIE', 'TIE', null])
  })

  it('leaves nothing playable behind when every round is tied', () => {
    for (const draftCount of [3, 4] as const) {
      const final = playMatch(startMatch({ mode: baseMode, draftCount }), ['TIE', 'TIE', 'TIE'])
      expect(final.status).toBe('COMPLETE')
      const unconsumed = (['A', 'B'] as const).flatMap((s) =>
        final.seats[s].slots.value.filter((slot) => !slot.consumed),
      )
      /*
       * Zero at both values now, for two different reasons — which is the point.
       *
       * At 3 regulation spends everything. At 4 it used to leave one per seat sitting there
       * unplayable, and this test asserted that as "the design and not an escape". D30 is the
       * admission that it was an escape: the characters were right there, and the match was
       * calling itself a draw next to them.
       */
      expect(unconsumed).toHaveLength(0)
    }
  })
})

describe('stopWhenDecided (D21)', () => {
  it('fires at 2–0, because only that score is mathematically settled', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'A', 'A'])

    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('A')
    // Round 2 is a dead rubber and is skipped.
    expect(final.rounds[2]!.result).toBeNull()
    expect(final.rounds[2]!.roll).toBeNull()
  })

  it('does NOT fire at 1.5–0.5, because a draw is still reachable', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['TIE', 'A', 'B'])

    // After two rounds: A has 1.5, B has 0.5. B can still reach 1.5 by taking round 3.
    expect(final.rounds[2]!.result).not.toBeNull()
    expect(final.status).toBe('COMPLETE')
  })

  it('plays all three rounds on a 1–1 split', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    // Regulation only: 2–1 is decided, so D30's overtime round is not owed and stays null.
    expect(final.rounds.slice(0, 3).every((r) => r.result !== null)).toBe(true)
    expect(final.rounds[3]!.result).toBeNull()
    expect(final.outcome).toBe('A')
  })

  it('is the general rule |lead| > roundsRemaining, not a hardcoded 2–0', () => {
    const state = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    expect(isDecided(state)).toBe(true) // the program is exhausted
  })
})

describe('UNDO_LAST_RESULT (D15)', () => {
  it('is offered to both seats after a result, and reverses the score', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = playToFirstReport(state, 'A')

    expect(state.seats.A.score).toBe(1)
    for (const seat of ['A', 'B'] as const) {
      expect(legalActions(state, seat).some((a) => a.type === 'UNDO_LAST_RESULT')).toBe(true)
    }

    // Either seat may undo — no confirmation, because §1 grants friendly opponents and the
    // real failure mode is a fat finger, not a lie.
    state = apply(state, 'B', { type: 'UNDO_LAST_RESULT', roundIndex: 0, requestedBy: 'B' })
    expect(state.seats.A.score).toBe(0)
    expect(state.rounds[0]!.result).toBeNull()

    // And the round can be reported again, differently.
    const report = currentAction(state, 'A', 'REPORT_RESULT')!
    expect(report.roundIndex).toBe(0)
    state = apply(state, 'A', {
      type: 'REPORT_RESULT',
      moduleId: report.moduleId,
      roundIndex: 0,
      reportedBy: 'A',
      outcome: 'TIE',
    })
    expect(state.seats.A.score).toBe(0.5)
    expect(state.seats.B.score).toBe(0.5)
  })

  it('survives the system bookkeeping that starts the next round', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = playToFirstReport(state, 'A')

    // Round 1 has no roll — D10 replaced it with an ASSIGN, which `settle` fires the instant
    // round 0's report lands. Under a literal reading of D15 ("open until the next round's
    // roll") that eagerness would leave a zero-width window. It does not: the window closes on
    // the next round's first *player* action, not on the system starting it.
    expect(state.rounds[1]!.roll).toBeNull()
    expect(state.rounds[1]!.privilegeHolder).not.toBeNull() // the ASSIGN already fired
    expect(legalActions(state, 'A').some((a) => a.type === 'UNDO_LAST_RESULT')).toBe(true)
  })

  it('closes once a seat acts in the next round', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = playToFirstReport(state, 'A')

    const ban = currentAction(state, state.rounds[1]!.privilegeHolder!, 'BAN')!
    state = apply(state, state.rounds[1]!.privilegeHolder!, {
      type: 'BAN',
      moduleId: ban.moduleId,
      roundIndex: 1,
      seat: state.rounds[1]!.privilegeHolder!,
      tier: 'ROUND',
      target: ban.targets[0]!,
    })

    expect(legalActions(state, 'A').some((a) => a.type === 'UNDO_LAST_RESULT')).toBe(false)
    expect(
      expectRejected(
        reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'undo',
          actor: 'A',
          payload: { type: 'UNDO_LAST_RESULT', roundIndex: 0, requestedBy: 'A' },
        }),
      ).code,
    ).toBe('UNDO_WINDOW_CLOSED')
  })

  it('survives the end of the match — the fat finger that decides it is the one worth covering', () => {
    // **This is one step beyond D15's letter, and is flagged rather than hidden.** D15 says
    // "open until the next round's roll", and on the final round there is no next roll. Its
    // stated purpose is to cover a fat finger; closing the window exactly where the mistake
    // decides the match would be perverse. Undo is therefore the only transition out of
    // COMPLETE, and it exists solely for this.
    let final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('A')

    const undo = legalActions(final, 'B').find((a) => a.type === 'UNDO_LAST_RESULT')
    expect(undo, 'undo should still be reachable at a terminal state').toBeDefined()

    final = apply(final, 'B', { type: 'UNDO_LAST_RESULT', roundIndex: 2, requestedBy: 'B' })
    expect(final.status).toBe('IN_PROGRESS')
    expect(final.outcome).toBeNull()

    // Rounds 0 and 1 went A then B, so undoing round 2 leaves 1–1. Re-reporting it for B
    // flips the match, and the engine re-completes rather than staying stuck open.
    expect(final.seats.A.score).toBe(1)
    expect(final.seats.B.score).toBe(1)

    const report = currentAction(final, 'B', 'REPORT_RESULT')!
    final = apply(final, 'B', {
      type: 'REPORT_RESULT',
      moduleId: report.moduleId,
      roundIndex: 2,
      reportedBy: 'B',
      outcome: 'B',
    })
    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('B')
  })

  it('refuses to undo a round that was never reported', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    const undone = legalActions(state, 'A').filter((a) => a.type === 'UNDO_LAST_RESULT')
    expect(undone).toHaveLength(0)
  })
})

/** Plays to the end of round 0 and reports `outcome`. */
function playToFirstReport(state: ReturnType<typeof startMatch>, outcome: RoundOutcome) {
  let current = state
  for (let guard = 0; guard < 100; guard++) {
    const seat = (['A', 'B'] as const).find((s) =>
      legalActions(current, s).some(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      ),
    )
    if (!seat) throw new Error('playToFirstReport: nobody can act')

    const report = currentAction(current, seat, 'REPORT_RESULT')
    if (report) {
      return apply(current, seat, {
        type: 'REPORT_RESULT',
        moduleId: report.moduleId,
        roundIndex: report.roundIndex,
        reportedBy: seat,
        outcome,
      })
    }
    const action = legalActions(current, seat).find(
      (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
    )!
    current = applyFirst(current, seat, action)
  }
  throw new Error('playToFirstReport: never reached a report')
}

function applyFirst(
  state: ReturnType<typeof startMatch>,
  seat: 'A' | 'B',
  action: ReturnType<typeof legalActions>[number],
) {
  switch (action.type) {
    case 'COMMIT':
      return apply(state, seat, {
        type: 'COMMIT',
        moduleId: action.moduleId,
        seat,
        picks: action.picks!.poolBySlot.map((pool, i) => pool[i]!),
        metaBan: null,
      })
    case 'CHOOSE':
      return apply(state, seat, {
        type: 'CHOOSE',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        option: action.options[0]!,
      })
    case 'BAN':
      return apply(state, seat, {
        type: 'BAN',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        tier: 'ROUND',
        target: action.targets[0]!,
      })
    case 'SELECT':
      return apply(state, seat, {
        type: 'SELECT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        slotIndex: action.slots[0]!,
        reason: null,
      })
    case 'ROLL':
      // The dice are gated on both seats asking for them, so a driver has to ask.
      return apply(state, seat, {
        type: 'ROLL_READY',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
      })
    default:
      throw new Error(`applyFirst: unexpected ${action.type}`)
  }
}
