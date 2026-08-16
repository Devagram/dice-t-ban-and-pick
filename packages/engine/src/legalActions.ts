import type { Action, MatchState, RoundOutcome, Seat } from '@banpick/types'

import { currentModule, roundAllowsTie } from './context.js'
import { moduleFor } from './modules/index.js'
import { resultsFrozen, undoableRound } from './undoWindow.js'

/**
 * Spec §11 non-negotiable 4 — "The client renders `legalActions()` and nothing else. It never
 * computes legality independently — and it is not given the code that could (D18)."
 *
 * So this is the entire surface a client has for deciding what to draw. Everything it must be
 * able to offer has to appear here, and anything absent here is not offerable.
 */
export function legalActions(state: MatchState, seat: Seat): Action[] {
  if (state.status === 'COMPLETE') {
    // D15's undo window survives the end of the match — see the note in reduce.ts. This is the
    // only action available at a terminal state, and it is the reason the state is reversible.
    return undoActions(state)
  }

  if (state.status === 'LOBBY') {
    return state.seatsFilled[seat] ? [] : [{ type: 'FILL_SEAT', moduleId: null }]
  }

  // The program can be exhausted while the match is still IN_PROGRESS: that is the one tick
  // between `reduce` consuming the final report and the caller draining MATCH_COMPLETE. The
  // undo must survive it — dropping it here would put a hole in D15's window at exactly the
  // moment the last result was entered.
  const mod = currentModule(state)
  if (!mod) return undoActions(state)

  return [...moduleFor(mod).legalActions({ state, mod }, seat), ...undoActions(state)]
}

/**
 * D15 — either seat may undo the most recent reported result. See undoWindow.ts for when.
 *
 * It is not scoped to a module, because the whole point is that it outlives the module that
 * produced it.
 */
function undoActions(state: MatchState): Action[] {
  const roundIndex = undoableRound(state)
  const undo: Action[] =
    roundIndex === null ? [] : [{ type: 'UNDO_LAST_RESULT', moduleId: null, roundIndex }]
  return [...undo, ...amendActions(state)]
}

/**
 * D33 — every round that has a result can be corrected, for the life of the match.
 *
 * Offered as one action carrying every amendable round rather than one action per round, because
 * the client draws a single "fix an earlier result" control and needs to know the whole set to
 * populate it. Each entry carries its own legal outcomes: D30's overtime round forbids the tie
 * the others allow, and §11 non-negotiable 4 says the client must not be the thing that knows.
 */
function amendActions(state: MatchState): Action[] {
  // D39 — frozen closes D33's amendment as well as D15's undo. A bracket that advanced on this
  // result cannot have the ground shift under it, and "correct an earlier round" is exactly that.
  if (resultsFrozen(state).frozen) return []

  const rounds = state.rounds
    .filter((r) => r.result !== null)
    .map((r) => ({
      roundIndex: r.index,
      current: r.result!,
      outcomes: (roundAllowsTie(state, r.index) ? ['A', 'B', 'TIE'] : ['A', 'B']) as RoundOutcome[],
    }))

  return rounds.length === 0 ? [] : [{ type: 'AMEND_RESULT', moduleId: null, rounds }]
}
