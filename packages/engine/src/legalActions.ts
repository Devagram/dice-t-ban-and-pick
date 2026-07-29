import type { Action, MatchState, Seat } from '@banpick/types'

import { currentModule } from './context.js'
import { moduleFor } from './modules/index.js'
import { undoableRound } from './undoWindow.js'

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
  return roundIndex === null ? [] : [{ type: 'UNDO_LAST_RESULT', moduleId: null, roundIndex }]
}
