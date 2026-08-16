import { baseMode, legalActions, project, reduce } from '@banpick/engine'
import { isDisputed, type MatchState, type Ruleset } from '@banpick/types'
import { describe, expect, it } from 'vitest'

import { apply, currentAction, driveUntil, expectRejected, startMatch, SEATS } from './helpers.js'

/**
 * **D38 and D39 — the phase that decides whether a bracket can be trusted.**
 *
 * Everything else in the tournament layer is plumbing. These are the two rules that stop a result
 * meaning one thing to the players and another to the bracket: both seats have to agree before a
 * round resolves, and once something outside has acted on that result the players stop being able
 * to move it.
 *
 * The last describe is the one to read if you only read one: **casual play is untouched.** D15's
 * reasoning about friends was never wrong, and a change made for tournaments that leaked into a
 * kitchen-table game would be a worse outcome than not having tournaments.
 */

const tournamentMatch = (): MatchState => {
  const state = startMatch({ mode: baseMode, draftCount: 4 })
  // The ruleset is snapshotted, so this is what `TournamentDO` produces at provisioning.
  const ruleset: Ruleset = { ...state.ruleset, resultReporting: 'BOTH_SEATS' }
  return { ...state, ruleset }
}

/** Drives to the first `REPORT_RESULT`, under whichever reporting rule the state carries. */
const toReport = (state: MatchState): MatchState =>
  driveUntil(state, (s) => currentAction(s, 'A', 'REPORT_RESULT') !== null)

const report = (state: MatchState, seat: 'A' | 'B', outcome: 'A' | 'B' | 'TIE'): MatchState => {
  const action = currentAction(state, seat, 'REPORT_RESULT')
  if (!action) throw new Error(`seat ${seat} has no report action`)
  return apply(state, seat, {
    type: 'REPORT_RESULT',
    moduleId: action.moduleId,
    roundIndex: action.roundIndex,
    reportedBy: seat,
    outcome,
  })
}

describe('D38 — both seats confirm', () => {
  it('does not resolve the round on one claim', () => {
    const state = report(toReport(tournamentMatch()), 'A', 'A')
    expect(state.rounds[0]!.result).toBeNull()
    expect(state.rounds[0]!.reports).toEqual({ A: 'A', B: null })
    // Nothing scored, so nothing downstream can have moved.
    expect(state.seats.A.score).toBe(0)
  })

  it('resolves when the second seat agrees', () => {
    let state = report(toReport(tournamentMatch()), 'A', 'A')
    state = report(state, 'B', 'A')
    expect(state.rounds[0]!.result).toBe('A')
    expect(state.seats.A.score).toBe(1)
  })

  it('tells the confirming seat what it is confirming', () => {
    const state = report(toReport(tournamentMatch()), 'A', 'A')
    // §11 non-negotiable 4 — the client is told this is a confirmation rather than working it out
    // from the round state, which would be the rule leaking into the client by another route.
    expect(currentAction(state, 'B', 'REPORT_RESULT')!.confirming).toBe('A')
    // And the seat that already claimed is not asked again.
    expect(currentAction(state, 'A', 'REPORT_RESULT')).toBeNull()
  })

  it('offers no `confirming` at all before anybody has claimed', () => {
    const state = toReport(tournamentMatch())
    for (const seat of SEATS) {
      expect(currentAction(state, seat, 'REPORT_RESULT')!.confirming).toBeNull()
    }
  })

  it('leaves the round disputed when they disagree, resolving nobody', () => {
    let state = report(toReport(tournamentMatch()), 'A', 'A')
    state = report(state, 'B', 'B')

    expect(isDisputed(state.rounds[0]!)).toBe(true)
    expect(state.rounds[0]!.result).toBeNull()
    expect(state.seats.A.score).toBe(0)
    expect(state.seats.B.score).toBe(0)
  })

  it('lets a dispute be settled by the two of them, without an organizer', () => {
    /*
     * The reason a disagreement does not immediately escalate. Two people who misreported and
     * then talked should be able to fix it; sending every fat finger to an organizer would make
     * the confirmation step cost more than it saves.
     */
    let state = report(toReport(tournamentMatch()), 'A', 'A')
    state = report(state, 'B', 'B')
    expect(SEATS.every((seat) => currentAction(state, seat, 'REPORT_RESULT') !== null)).toBe(true)

    state = report(state, 'A', 'B')
    expect(state.rounds[0]!.result).toBe('B')
    expect(isDisputed(state.rounds[0]!)).toBe(false)
  })

  it('refuses a seat re-sending the claim it already made', () => {
    const state = report(toReport(tournamentMatch()), 'A', 'A')
    const action = currentAction(state, 'B', 'REPORT_RESULT')!
    const again = reduce(state, {
      v: 1,
      seq: state.log.length,
      tag: 'x',
      actor: 'A',
      payload: {
        type: 'REPORT_RESULT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        reportedBy: 'A',
        outcome: 'A',
      },
    })
    // A double-clicked button is visibly a no-op rather than a second log entry saying the same
    // thing twice.
    expect(expectRejected(again).code).toBe('DUPLICATE_COMMIT')
  })
})

describe('D39 — a consumed result freezes', () => {
  const frozen = (state: MatchState): MatchState =>
    apply(state, 'SYSTEM', { type: 'RESULTS_FROZEN', reason: 'the bracket advanced' })

  const played = (): MatchState => {
    let state = report(toReport(tournamentMatch()), 'A', 'A')
    state = report(state, 'B', 'A')
    return state
  }

  it('closes D15’s undo and D33’s amendment for the players', () => {
    const before = played()
    expect(legalActions(before, 'A').map((a) => a.type)).toContain('UNDO_LAST_RESULT')

    const after = frozen(before)
    const types = legalActions(after, 'A').map((a) => a.type)
    expect(types).not.toContain('UNDO_LAST_RESULT')
    expect(types).not.toContain('AMEND_RESULT')
  })

  it('says why, rather than a control quietly vanishing', () => {
    // A player is looking at a screen that had an undo button on it a moment ago. The reason
    // travels on the view so the client does not have to invent one.
    const view = project(frozen(played()), 'A')
    expect(view.frozen).toEqual({ reason: 'the bracket advanced' })
    expect(project(played(), 'A').frozen).toBeNull()
  })

  it('is the same fact for both seats', () => {
    const state = frozen(played())
    expect(project(state, 'A').frozen).toEqual(project(state, 'B').frozen)
  })

  it('is idempotent — freezing twice says what freezing once said', () => {
    const twice = frozen(frozen(played()))
    expect(project(twice, 'A').frozen).not.toBeNull()
    expect(legalActions(twice, 'A').map((a) => a.type)).not.toContain('UNDO_LAST_RESULT')
  })
})

describe('casual play is untouched', () => {
  /*
   * The regression that would matter most. D15's reasoning — a confirm step is ceremony against a
   * trusted counterparty, and the real failure is a fat finger — was never wrong, and it applies
   * to every match nobody put in a bracket.
   */
  it('still resolves on one claim, with no confirmation', () => {
    const state = report(toReport(startMatch({ mode: baseMode, draftCount: 4 })), 'A', 'A')
    expect(state.rounds[0]!.result).toBe('A')
    expect(state.seats.A.score).toBe(1)
  })

  it('never asks anybody to confirm', () => {
    const state = toReport(startMatch({ mode: baseMode, draftCount: 4 }))
    expect(currentAction(state, 'A', 'REPORT_RESULT')!.confirming).toBeNull()
    const after = report(state, 'A', 'A')
    // Reported and done: the other seat is not handed a confirmation it was never meant to give.
    expect(currentAction(after, 'B', 'REPORT_RESULT')).toBeNull()
  })

  it('keeps D15’s undo window exactly as it was', () => {
    const state = report(toReport(startMatch({ mode: baseMode, draftCount: 4 })), 'A', 'A')
    expect(legalActions(state, 'A').map((a) => a.type)).toContain('UNDO_LAST_RESULT')
    expect(legalActions(state, 'B').map((a) => a.type)).toContain('UNDO_LAST_RESULT')
    expect(project(state, 'A').frozen).toBeNull()
  })
})
