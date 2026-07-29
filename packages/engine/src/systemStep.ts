import type { EventEnvelope, MatchState } from '@banpick/types'

import { currentModule, envelope } from './context.js'
import { moduleFor } from './modules/index.js'
import { isDecided, matchOutcome, reduce } from './reduce.js'

/**
 * The auto-commit driver (D26), and the general answer to "who appends the events nobody
 * decides".
 *
 * D26 says `SELECT` auto-commits when exactly one legal option exists, emitting a `SYSTEM`
 * event with `reason: FORCED`. The spec states the rule but not who emits it — and a pure,
 * single-event `reduce` cannot append to its own log.
 *
 * So: `systemStep` *returns* the next SYSTEM event and the caller appends it. Rolls, reveals,
 * D10's inversion, forced selects, and the terminal `MATCH_COMPLETE` all arrive the same way.
 * The result is that `reduce` stays pure and single-event, the log stays complete and
 * replayable (D13's principle), and Phase 3's Durable Object gets one obvious integration
 * point instead of a cascade hidden inside the reducer.
 */
export function systemStep(state: MatchState): EventEnvelope | null {
  // `status` is the guard against emitting MATCH_COMPLETE twice, deliberately rather than a
  // scan for a prior one in the log: undoing the final round's result reopens the match (D15,
  // see reduce.ts), and a log-based guard would then refuse to ever complete it again.
  if (state.status !== 'IN_PROGRESS') return null

  if (isDecided(state)) {
    return envelope(state.log.length, 'match:complete', 'SYSTEM', {
      type: 'MATCH_COMPLETE',
      outcome: matchOutcome(state),
    })
  }

  const mod = currentModule(state)
  if (!mod) return null

  return moduleFor(mod).systemEvent({ state, mod }, state.log.length)
}

/**
 * Drains `systemStep` until the match is waiting on a human (or is over).
 *
 * The cap is a backstop, not a design parameter: every system event either advances the cursor
 * or completes the match, so a program that does not settle is a bug, and a hang is the worst
 * possible way to report one.
 */
export function settle(state: MatchState, limit = 256): MatchState {
  let current = state
  for (let i = 0; i < limit; i++) {
    const event = systemStep(current)
    if (!event) return current
    const result = reduce(current, event)
    if (!result.ok) {
      throw new Error(
        `settle: the engine authored an event its own reducer rejected ` +
          `(${result.code}: ${result.detail}). This is an engine bug, not a player action.`,
      )
    }
    current = result.state
  }
  throw new Error('settle: system events did not settle — the program does not terminate')
}
