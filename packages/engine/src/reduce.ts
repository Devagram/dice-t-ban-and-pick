import {
  regulationRounds,
  SEATS,
  type EventEnvelope,
  type MatchOutcome,
  type MatchState,
  type ReduceResult,
} from '@banpick/types'

import { cloneState, currentModule, reject, roundAllowsTie } from './context.js'
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
  if (event.payload.type === 'PAIRING_RESOLVED') return resolvePairing(state, event)
  if (event.payload.type === 'UNDO_LAST_RESULT') return undoLastResult(state, event)
  if (event.payload.type === 'AMEND_RESULT') return amendResult(state, event)
  /*
   * D39 — a tournament has advanced on this result.
   *
   * Accepted at any status, including COMPLETE, because that is the only status it ever arrives
   * at: the bracket consumes a *finished* match. Idempotent by being additive — a second freeze
   * says the same thing the first one did.
   */
  if (event.payload.type === 'RESULTS_FROZEN') {
    const next = cloneState(state)
    next.log.push(event)
    return { ok: true, state: next }
  }
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
 * D28 — the cross-match ban history, arriving as an event.
 *
 * The DO reads it from the pairing's own object and writes it here the moment the second seat
 * fills, which is the first point at which the pairing is known: a room is opened before anyone
 * sits, so this cannot ride on `MATCH_CREATED` beside the roster and the ruleset.
 *
 * Deliberately not enforced against the ruleset here. If the host allowed repeats, the DO simply
 * does not send this, and the pool has no term to subtract with — the rule lives in one place
 * (`legalMetaBanPoolExpr`) rather than being half-checked in two.
 */
function resolvePairing(state: MatchState, event: EventEnvelope): ReduceResult {
  const p = event.payload
  if (p.type !== 'PAIRING_RESOLVED') return reject('WRONG_PHASE', 'expected PAIRING_RESOLVED')
  // Before the ban is placed, which is the only thing it can affect. Late would mean a pool that
  // narrowed under a player mid-decision.
  if (state.log.some((e) => e.payload.type === 'COMMIT')) {
    return reject('WRONG_PHASE', 'the pairing resolves before anything is committed')
  }

  const next = cloneState(state)
  next.deniedMetaBans = { A: [...p.deniedMetaBans.A], B: [...p.deniedMetaBans.B] }
  next.log.push(event)
  return { ok: true, state: advance(next) }
}

/**
 * **D33 — correct a round that was reported wrong, however long ago.**
 *
 * D15's undo covers the result you just entered and shuts as soon as the next round starts. That
 * is the right shape for a fat finger caught immediately and the wrong shape for the mistake you
 * notice two rounds later, which is the one that actually survives to matter. This reopens every
 * reported round for the whole life of the match.
 *
 * **What it costs, said plainly:** D15's window was also a limit on rewriting history, and this
 * removes it. §1's trust model is the justification — friendly opponents, and the failure mode is
 * a mistake rather than a lie — but a player *can* now change a round they lost an hour ago. The
 * other seat is told (see `RESULT_AMENDED`), which is the check that replaces the window.
 *
 * **The cursor needs no rewinding, which is not obvious and was worth proving.** Changing an old
 * result can make a round live that `stopWhenDecided` skipped, or make D30's overtime owed. The
 * first draft of this rewound the cursor to zero and walked it forward to be safe; a mutation test
 * then showed that removing the rewind broke nothing, because the cursor can never have got past
 * the round in question. `advance` is the only thing that moves it forward and it stops at the
 * first incomplete module — so a skipped round always sits at or ahead of the cursor, never
 * behind it. Amending cannot make a completed module incomplete either: a round with a different
 * result still has one. `advance` from where we are is therefore sufficient, and the rewind was
 * a line that looked load-bearing while doing nothing.
 */
function amendResult(state: MatchState, event: EventEnvelope): ReduceResult {
  const p = event.payload
  if (p.type !== 'AMEND_RESULT') return reject('WRONG_PHASE', 'expected AMEND_RESULT')

  const round = state.rounds[p.roundIndex]
  if (!round || round.result === null) {
    return reject('NOTHING_TO_UNDO', `round ${p.roundIndex} has no reported result to amend`)
  }

  // The round's own report module decides what it will accept — D30's overtime forbids the tie
  // the others allow, and that rule lives in the program rather than here.
  if (p.outcome === 'TIE' && !roundAllowsTie(state, p.roundIndex)) {
    return reject('ILLEGAL_OPTION', `round ${p.roundIndex} does not allow ties`)
  }
  if (round.result === p.outcome) {
    // Not an error worth a rejection code of its own, but appending a no-op event would put a
    // correction in the log that corrected nothing.
    return reject('DUPLICATE_COMMIT', `round ${p.roundIndex} already reads ${p.outcome}`)
  }

  const next = cloneState(state)
  const target = next.rounds[p.roundIndex]!
  applyScore(next, target.result!, -1)
  applyScore(next, p.outcome, +1)
  target.result = p.outcome

  // The match re-decides itself from the new score. `settle` emits MATCH_COMPLETE again if it is
  // still over — possibly with a different winner, which D29's upsert-by-room-code then records
  // over the old one rather than beside it.
  next.status = 'IN_PROGRESS'
  next.outcome = null

  next.log.push(event)
  // `advance` is a no-op here — amending completes no module, since a round with a different
  // result still has one — and is kept only because every other reducer ends this way. Written
  // down because a mutation test proved it does nothing, and the next person deserves to know
  // that before they go looking for what it fixes.
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
 * The mode's declared regulation length with `stopWhenDecided`, and D30's overtime.
 *
 * Regulation is the general form `|lead| > roundsRemaining`, which reduces to exactly what D21
 * describes for a Bo3: after two rounds only 2–0 is settled, because at 1.5–0.5 a draw is still
 * reachable and a draw is a legal terminal state. The same expression handles D36's one-round
 * mode without a branch — a single round has nothing remaining and nothing to skip.
 *
 * **Overtime is counted separately, and that separation is the whole trick.** It is a round in
 * the program but not a round anyone can win the match in during regulation, so folding it into
 * `remaining` would make a 2–0 lead after two rounds look unsettled and drag a dead rubber back
 * onto the board. `regulationRounds` is therefore the regulation count and `state.rounds.length`
 * is the array size — see the note on both in `@banpick/types`.
 */
export function isDecided(state: MatchState): boolean {
  if (state.cursor >= state.mode.program.length) return true

  const regulation = state.rounds.filter((r) => r.index < regulationRounds(state.mode.match))
  const remaining = regulation.length - regulation.filter((r) => r.result !== null).length
  const lead = Math.abs(state.seats.A.score - state.seats.B.score)

  if (remaining > 0) return state.mode.match.stopWhenDecided ? lead > remaining : false

  // Regulation is over. Everything past here is about whether overtime is owed.
  if (!state.mode.overtime.enabled) return true
  if (lead > 0) return true

  return !bothSeatsCanPlayOn(state)
}

/**
 * D30 — enabled is not the same as playable.
 *
 * At `draftCount: 3` every character is spent by the end of regulation, so a level match is a
 * draw exactly as D21 says. At 4 each seat holds one back and there is a decider to play. The
 * same mode file covers both because this is a question about the board, not about the
 * parameter — which also means a mode that spends its characters some other way gets the right
 * answer without anyone remembering to special-case it.
 */
function bothSeatsCanPlayOn(state: MatchState): boolean {
  const overtime = state.rounds.find((r) => r.index >= regulationRounds(state.mode.match))
  return SEATS.every(
    (seat) =>
      state.seats[seat].slots.value.some((slot) => !slot.consumed) ||
      /*
       * Or has already played it. Overtime's own SELECT consumes the very character that made
       * the round available, so a bare "is anything left?" flips to false halfway through and
       * ends the match in the gap between the select and the result — which is exactly what it
       * did before this clause. Read together the two say "had a character when regulation
       * ended", which is the question, and they keep saying it while the round is underway and
       * again if D15 undoes the result.
       */
      overtime?.selection[seat].value !== null,
  )
}

export function matchOutcome(state: MatchState): MatchOutcome {
  const a = state.seats.A.score
  const b = state.seats.B.score
  if (a > b) return 'A'
  if (b > a) return 'B'
  return 'DRAW'
}
