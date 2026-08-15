import { describe, expect, it } from 'vitest'
import { baseMode, legalActions, project } from '@banpick/engine'

import { apply, currentAction, playMatch, startMatch } from './helpers.js'

/**
 * **D30 — the tiebreaker round.**
 *
 * D21 accepted 1.5–1.5 as a legal terminal state on the grounds that three rounds against three
 * characters leaves nothing to play. At `draftCount: 4` that reasoning stopped holding: each seat
 * finishes regulation still holding one character, and the match was calling itself a draw with
 * the decider sitting on the board.
 *
 * The rule is conditional on the *board*, not on the parameter — "both seats still hold something"
 * — so one mode file covers 3 and 4 without a branch. These tests are mostly about the edges of
 * that condition, because that is where a rule like this goes wrong.
 */

const level = ['TIE', 'TIE', 'TIE'] as const

describe('overtime fires exactly when it is owed', () => {
  it('breaks a level match at draftCount 4', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), [...level, 'B'])

    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('B')
    expect(final.rounds.map((r) => r.result)).toEqual(['TIE', 'TIE', 'TIE', 'B'])
    expect(final.seats.B.score).toBe(2.5)
    expect(final.seats.A.score).toBe(1.5)
  })

  it('does not fire at draftCount 3, where regulation spent the last character', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), [...level])

    expect(final.outcome).toBe('DRAW')
    expect(final.rounds[3]!.result).toBeNull()
  })

  it('does not fire when regulation separated them', () => {
    // 2–1. A tiebreaker for a match that has a winner would be a fourth round, not overtime.
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])

    expect(final.outcome).toBe('A')
    expect(final.rounds[3]!.result).toBeNull()
    expect(final.rounds[3]!.roll).toBeNull()
  })

  it('does not fire after a dead rubber was skipped, where the score is not level', () => {
    // 2–0 stops at round 1 under `stopWhenDecided`, leaving two characters per seat unplayed.
    // Having characters in hand is necessary for overtime, not sufficient.
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'A', 'A'])

    expect(final.outcome).toBe('A')
    expect(final.rounds[2]!.result).toBeNull()
    expect(final.rounds[3]!.result).toBeNull()
    expect(final.seats.A.slots.value.filter((s) => !s.consumed)).toHaveLength(2)
  })

  it('plays the character each seat held back, and nothing is left over', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), [...level, 'A'])

    for (const seat of ['A', 'B'] as const) {
      expect(final.seats[seat].slots.value.every((s) => s.consumed)).toBe(true)
    }
    // The round each seat played it in.
    expect(final.rounds[3]!.selection.A.value).not.toBeNull()
    expect(final.rounds[3]!.selection.B.value).not.toBeNull()
  })
})

describe('overtime cannot end level', () => {
  it('offers only a winner, never a tie', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = playToOvertimeReport(state)

    const report = currentAction(state, 'A', 'REPORT_RESULT')!
    expect(report.roundIndex).toBe(3)
    // The one thing that distinguishes it from round 2. A tiebreaker that can tie leaves
    // 2.0–2.0 with an empty board — the deadlock G14 refuses.
    expect(report.outcomes).toEqual(['A', 'B'])
  })

  it('refuses a reported tie outright', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = playToOvertimeReport(state)
    const report = currentAction(state, 'A', 'REPORT_RESULT')!

    expect(() =>
      apply(state, 'A', {
        type: 'REPORT_RESULT',
        moduleId: report.moduleId,
        roundIndex: 3,
        reportedBy: 'A',
        outcome: 'TIE',
      }),
    ).toThrow()
  })
})

describe('undo reaches into overtime (D15)', () => {
  it('reopens the match and lets the decider be reported the other way', () => {
    let final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), [...level, 'A'])
    expect(final.outcome).toBe('A')

    final = apply(final, 'B', { type: 'UNDO_LAST_RESULT', roundIndex: 3, requestedBy: 'B' })
    expect(final.status).toBe('IN_PROGRESS')
    // Back to level — and still owed overtime, which is the case the availability check has to
    // keep answering "yes" to after the characters it asked about are already spent.
    expect(final.seats.A.score).toBe(1.5)
    expect(final.seats.B.score).toBe(1.5)

    const report = currentAction(final, 'B', 'REPORT_RESULT')!
    expect(report.roundIndex).toBe(3)
    final = apply(final, 'B', {
      type: 'REPORT_RESULT',
      moduleId: report.moduleId,
      roundIndex: 3,
      reportedBy: 'B',
      outcome: 'B',
    })
    expect(final.status).toBe('COMPLETE')
    expect(final.outcome).toBe('B')
  })
})

describe('what each seat is shown (§7, §11)', () => {
  it('shows the overtime round only where it could be reached', () => {
    // Compared after the draft, because that is when a seat has characters to hold back — and
    // the strip does not render before the first round anyway.
    const four = project(afterDraft(startMatch({ mode: baseMode, draftCount: 4 })), 'A')
    const three = project(afterDraft(startMatch({ mode: baseMode, draftCount: 3 })), 'A')

    expect(four.rounds).toHaveLength(4)
    expect(four.rounds[3]!.overtime).toBe(true)
    // At 3 it is dropped rather than shown greyed: a pip for a round that cannot happen is a
    // lie, and deciding which rounds exist is a rule, so the engine decides it.
    expect(three.rounds).toHaveLength(3)
    expect(three.rounds.every((r) => !r.overtime)).toBe(true)
  })

  it('shows three rounds for a mode that declares no overtime at all', () => {
    /*
     * Both shipped modes enable it, so this is the branch nothing else reaches — and it is the
     * one that matters if a mode is ever added without a tiebreaker. Built by flipping the flag
     * rather than by adding a fixture mode, because the flag is exactly what is under test.
     */
    const noOvertime = { ...baseMode, overtime: { enabled: false } }
    const state = afterDraft(startMatch({ mode: noOvertime, draftCount: 4 }))

    expect(state.rounds).toHaveLength(3)
    const view = project(state, 'A')
    expect(view.rounds).toHaveLength(3)
    expect(view.rounds.every((r) => !r.overtime)).toBe(true)
  })

  it('keeps showing it once it has been played', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), [...level, 'A'])
    const view = project(final, 'B')

    expect(view.rounds).toHaveLength(4)
    expect(view.rounds[3]).toMatchObject({ overtime: true, result: 'A' })
  })
})

/** Drives only as far as both drafts being in, which is when slots exist to reason about. */
function afterDraft(state: ReturnType<typeof startMatch>) {
  let current = state
  for (let guard = 0; guard < 20; guard++) {
    const seat = (['A', 'B'] as const).find((s) =>
      legalActions(current, s).some((a) => a.type === 'COMMIT'),
    )
    if (!seat) return current
    const commit = legalActions(current, seat).find((a) => a.type === 'COMMIT')!
    current = step(current, seat, commit)
  }
  throw new Error('afterDraft: the draft never closed')
}

/** Plays three tied rounds and stops with the overtime report on the table. */
function playToOvertimeReport(state: ReturnType<typeof startMatch>) {
  let current = state
  for (let guard = 0; guard < 300; guard++) {
    const report = (['A', 'B'] as const)
      .map((s) => currentAction(current, s, 'REPORT_RESULT'))
      .find(Boolean)
    if (report && report.roundIndex === 3) return current

    const seat = (['A', 'B'] as const).find((s) =>
      legalActions(current, s).some(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      ),
    )
    if (!seat) throw new Error('playToOvertimeReport: nobody can act')
    const action = legalActions(current, seat).find(
      (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
    )!

    current =
      action.type === 'REPORT_RESULT'
        ? apply(current, seat, {
            type: 'REPORT_RESULT',
            moduleId: action.moduleId,
            roundIndex: action.roundIndex,
            reportedBy: seat,
            outcome: 'TIE',
          })
        : step(current, seat, action)
  }
  throw new Error('playToOvertimeReport: never reached overtime')
}

function step(
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
      return apply(state, seat, {
        type: 'ROLL_READY',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
      })
    default:
      throw new Error(`step: unexpected ${action.type}`)
  }
}
