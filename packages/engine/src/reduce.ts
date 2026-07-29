import {
  SEATS,
  type EventEnvelope,
  type MatchOutcome,
  type MatchState,
  type ReduceResult,
} from '@banpick/types'

import { cloneState, currentModule, reject } from './context.js'
import { moduleFor } from './modules/index.js'
import { applyScore } from './modules/reportResult.js'
import { createMatch, ENGINE_VERSION, majorOf } from './createMatch.js'
import { undoableRound } from './undoWindow.js'

/**
 * Spec §5 — `reduce(state, event) => state`. Pure, total, single-event.
 *
 * **Total, not throwing.** An illegal event returns a rejection value. Throwing reducers and
 * event sourcing are a bad marriage: a throw mid-fold leaves no record of what was attempted
 * and no way to distinguish "your action was illegal" from "the engine has a bug".
 *
 * **Single-event.** Cascades (D26's auto-commit, rolls, reveals) are *not* performed here.
 * `systemStep` returns the next SYSTEM event and the caller appends it, so every state
 * transition in the match has exactly one event in the log and the log alone replays it.
 */
export function reduce(state: MatchState | null, event: EventEnvelope): ReduceResult {
  if (event.payload.type === 'MATCH_CREATED') {
    if (state !== null) return reject('ALREADY_CREATED', 'the match already exists')
    if (majorOf(event.payload.engineVersion) !== majorOf(ENGINE_VERSION)) {
      // D16 — loud, not silent. A log written before a `reduce` semantics change replays to a
      // different terminal state, and producing that answer confidently is the failure mode.
      return reject(
        'ENGINE_VERSION_MISMATCH',
        `log was written by engine ${event.payload.engineVersion}, this is ${ENGINE_VERSION}`,
      )
    }
    return { ok: true, state: createMatch(event) }
  }

  if (state === null) return reject('MATCH_NOT_CREATED', 'no MATCH_CREATED event yet')

  if (event.payload.type === 'SEAT_FILLED') return fillSeat(state, event)
  if (event.payload.type === 'UNDO_LAST_RESULT') return undoLastResult(state, event)
  if (event.payload.type === 'MATCH_COMPLETE') {
    const next = cloneState(state)
    next.status = 'COMPLETE'
    next.outcome = event.payload.outcome
    next.log.push(event)
    return { ok: true, state: next }
  }

  if (state.status === 'COMPLETE') {
    return reject('MATCH_COMPLETE', 'the match has ended')
  }
  if (state.status === 'LOBBY') {
    return reject('WRONG_PHASE', 'both seats must be filled before play begins')
  }

  const mod = currentModule(state)
  if (!mod) return reject('WRONG_PHASE', 'the program has no module left to run')

  // Dispatch on the module the event names before handing it to the current one. Without this,
  // a resubmitted action lands on whatever module the cursor has since advanced to and comes
  // back as WRONG_PHASE — accurate, and useless to a caller trying to tell "you already did
  // that" from "that is not a thing you can do". Phase 3 layers idempotency keys on top of
  // these codes, and a double-clicked commit is expected traffic, not an anomaly.
  const named = 'moduleId' in event.payload ? event.payload.moduleId : null
  if (named !== null && named !== mod.id) {
    const index = state.mode.program.findIndex((m) => m.id === named)
    if (index >= 0 && index < state.cursor) {
      return reject('WRONG_MODULE', `${named} has already completed; the match is at ${mod.id}`)
    }
    return reject('WRONG_MODULE', `${named} is not the current module (${mod.id})`)
  }

  const impl = moduleFor(mod)
  const result = impl.apply({ state, mod }, event)
  if (!result.ok) return result

  return { ok: true, state: advance(result.state) }
}

/**
 * Advances the cursor past every module that is now complete.
 *
 * A loop rather than a single step because removing modules (D10's round 1) can leave a run of
 * modules that complete without any event at all — and because a forced select can complete a
 * module the same instant its predecessor finished.
 */
function advance(state: MatchState): MatchState {
  let cursor = state.cursor
  while (cursor < state.mode.program.length) {
    const mod = state.mode.program[cursor]!
    if (!moduleFor(mod).isComplete({ state: { ...state, cursor }, mod })) break
    cursor++
  }
  return cursor === state.cursor ? state : { ...state, cursor }
}

function fillSeat(state: MatchState, event: EventEnvelope): ReduceResult {
  const p = event.payload
  if (p.type !== 'SEAT_FILLED') return reject('WRONG_PHASE', 'expected SEAT_FILLED')
  if (state.status !== 'LOBBY') return reject('WRONG_PHASE', 'the lobby is closed')
  if (state.seatsFilled[p.seat]) return reject('SEAT_TAKEN', `seat ${p.seat} is taken`)

  const next = cloneState(state)
  next.seatsFilled[p.seat] = true
  // §12.4 — SEAT_FILLED locks the ruleset. Seating is the consent, so it is also the point of
  // no return: the host may abandon and reopen, never edit in place.
  if (SEATS.every((s) => next.seatsFilled[s])) next.status = 'IN_PROGRESS'
  next.log.push(event)
  return { ok: true, state: advance(next) }
}

/**
 * D15 — either seat, no confirmation, open until the next round's roll.
 *
 * **One extension beyond D15's letter, flagged rather than hidden:** the window also stays open
 * on the final round, where the match has already completed. D15's stated purpose is to cover a
 * fat finger, and the fat finger that decides the match is the one most worth covering; closing
 * the window exactly there would be perverse. Undoing a completed match reopens it — the only
 * transition out of COMPLETE, and it exists solely for this.
 */
function undoLastResult(state: MatchState, event: EventEnvelope): ReduceResult {
  const p = event.payload
  if (p.type !== 'UNDO_LAST_RESULT') return reject('WRONG_PHASE', 'expected UNDO_LAST_RESULT')

  const round = state.rounds[p.roundIndex]
  if (!round || round.result === null) {
    return reject('NOTHING_TO_UNDO', `round ${p.roundIndex} has no reported result`)
  }
  const undoable = undoableRound(state)
  if (undoable === null) {
    return reject('UNDO_WINDOW_CLOSED', 'the next round is already underway')
  }
  if (undoable !== p.roundIndex) {
    return reject('NOTHING_TO_UNDO', `round ${p.roundIndex} is not the most recent result`)
  }

  const next = cloneState(state)
  const target = next.rounds[p.roundIndex]!
  applyScore(next, target.result!, -1)
  target.result = null

  // Rewind the cursor to that round's report module so it can be reported again.
  const reportIdx = next.mode.program.findIndex(
    (m) => m.type === 'REPORT_RESULT' && m.roundIndex === p.roundIndex,
  )
  if (reportIdx >= 0) next.cursor = reportIdx
  next.status = 'IN_PROGRESS'
  next.outcome = null

  next.log.push(event)
  return { ok: true, state: next }
}

// --- Match resolution (§10, D21) ------------------------------------------------------------

/**
 * `ALWAYS_3_ROUNDS` with `stopWhenDecided`.
 *
 * The general form is `|lead| > roundsRemaining`, which reduces to exactly what D21 describes:
 * after two rounds only 2–0 is settled, because at 1.5–0.5 a draw is still reachable and a
 * draw is a legal terminal state.
 */
export function isDecided(state: MatchState): boolean {
  if (state.cursor >= state.mode.program.length) return true
  if (!state.mode.match.stopWhenDecided) return false

  const played = state.rounds.filter((r) => r.result !== null).length
  const remaining = state.rounds.length - played
  const lead = Math.abs(state.seats.A.score - state.seats.B.score)
  return lead > remaining
}

export function matchOutcome(state: MatchState): MatchOutcome {
  const a = state.seats.A.score
  const b = state.seats.B.score
  if (a > b) return 'A'
  if (b > a) return 'B'
  return 'DRAW'
}
