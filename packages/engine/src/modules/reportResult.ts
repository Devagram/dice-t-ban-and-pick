import {
  isDisputed as disputedRound,
  otherSeat,
  SEATS,
  type Action,
  type EventEnvelope,
  type ReportResultSpec,
  type ResolvedModule,
  type RoundOutcome,
  type Seat,
} from '@banpick/types'

import {
  cloneState,
  findRoundIndex,
  reject,
  roundOf,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'

type ReportModule = ReportResultSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<ReportModule>

/**
 * Spec §8 — "Record round outcome, including ties."
 *
 * §17 states the non-goal outright: **this app does not simulate, score, or validate the dice
 * game.** It brackets the game. `REPORT_RESULT` is therefore the single point where an
 * unverifiable human claim enters an otherwise fully authoritative system, and that is by
 * design.
 *
 * D15 accordingly, and **still, for casual play**: either seat reports, no confirmation. A confirm
 * step is ceremony against a trusted counterparty (§1), and the real failure mode is a fat finger,
 * which `UNDO_LAST_RESULT` covers.
 *
 * **D38 adds the other shape, for tournaments only.** `resultReporting: 'BOTH_SEATS'` makes the
 * round wait for both claims and resolve only if they agree; disagreeing claims leave it disputed.
 * This is the two-sided schema SPEC-GAPS recommended and §17 withdrew — withdrawn *because* D19
 * ruled tournaments out, which D37 reverses. The comment there now says so too.
 *
 * Which shape applies is a **property of the match**, read off the snapshotted ruleset, not a mode
 * of the app: a casual game between friends and a quarter-final can be running side by side in the
 * same deployment and neither should behave like the other.
 */
export const reportResult: PhaseModule<ReportModule> = {
  reads: [],
  writes: [],
  /** Produces the result the match rule scores. Without it nothing terminates. */
  essential: true,

  awaiting({ state, mod }: Ctx): Seat[] {
    if (resolved(state, mod)) return []
    if (!bothSeats(state)) return [...SEATS]
    // Under D38 a seat that has already claimed is not being waited on — but a seat whose claim
    // was contradicted is, because it may change it. Disputed rounds await both again.
    const round = state.rounds[findRoundIndex(mod)]!
    if (disputedRound(round)) return [...SEATS]
    return SEATS.filter((seat) => round.reports[seat] === null)
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (resolved(state, mod)) return []
    const outcomes: RoundOutcome[] = mod.allowTie ? ['A', 'B', 'TIE'] : ['A', 'B']
    const round = state.rounds[findRoundIndex(mod)]!

    if (bothSeats(state)) {
      // Nothing to offer a seat that has claimed and has not been contradicted: it is waiting on
      // the other one, and a control that re-submits the same answer is noise.
      if (round.reports[seat] !== null && !disputedRound(round)) return []
    }

    return [
      {
        type: 'REPORT_RESULT',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        outcomes,
        // What the *other* seat has claimed, so the client can render "confirm or disagree"
        // without deciding on its own that this is a confirmation (§11 non-negotiable 4).
        confirming: bothSeats(state) ? round.reports[otherSeat(seat)] : null,
      },
    ]
  },

  systemEvent(): EventEnvelope | null {
    return null
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload
    if (p.type !== 'REPORT_RESULT') {
      return reject('WRONG_PHASE', `${mod.id} expects REPORT_RESULT, got ${p.type}`)
    }
    if (resolved(state, mod)) {
      return reject('DUPLICATE_COMMIT', `round ${mod.roundIndex} is already reported`)
    }
    if (p.outcome === 'TIE' && !mod.allowTie) {
      return reject('ILLEGAL_OPTION', `${mod.id} does not allow ties`)
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)

    if (!bothSeats(next)) {
      // D15 — one claim settles it. Unchanged, and the `reports` entry is recorded alongside so
      // the two shapes leave the same shape of state behind.
      round.reports[p.reportedBy] = p.outcome
      round.result = p.outcome
      applyScore(next, p.outcome, +1)
      next.log.push(event)
      return { ok: true, state: next }
    }

    if (round.reports[p.reportedBy] === p.outcome) {
      // Re-sending the same claim changes nothing and would otherwise sit in the log as a second
      // event saying the same thing. Refused rather than absorbed, so a double-clicked button is
      // visibly a no-op instead of quietly growing the log.
      return reject('DUPLICATE_COMMIT', `seat ${p.reportedBy} already claimed ${p.outcome}`)
    }

    round.reports[p.reportedBy] = p.outcome
    const other = round.reports[otherSeat(p.reportedBy)]

    /*
     * Agreement resolves. Disagreement does **not** — and it also does not pick a winner, escalate,
     * or invent a tiebreak. The round simply stays open with both claims on it, both seats able to
     * change theirs, and (in a tournament) the slot showing as disputed to the organizer. Two
     * people who disagree about who won is not a case an algorithm should settle.
     */
    if (other !== null && other === p.outcome) {
      round.result = p.outcome
      applyScore(next, p.outcome, +1)
    }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return resolved(state, mod)
  },
}

/**
 * D21 — `HALF_POINT` and nothing else. A tied round awards 0.5 to each seat, and 1.5–1.5 is a
 * legal terminal state: the match is a draw.
 *
 * Halves are exactly representable in binary floating point, so scores stay safe to compare
 * and to canonicalize.
 */
export function applyScore(state: Ctx['state'], outcome: RoundOutcome, sign: 1 | -1): void {
  if (outcome === 'TIE') {
    state.seats.A.score += 0.5 * sign
    state.seats.B.score += 0.5 * sign
  } else {
    state.seats[outcome].score += 1 * sign
  }
}

/** Agreed, and therefore scored. A disputed round is reported twice and resolved zero times. */
function resolved(state: Ctx['state'], mod: ReportModule): boolean {
  const result = state.rounds[findRoundIndex(mod)]?.result
  return result !== null && result !== undefined
}

/** D38 — read off the snapshotted ruleset, so a replay applies what the match was played under. */
function bothSeats(state: Ctx['state']): boolean {
  return state.ruleset.resultReporting === 'BOTH_SEATS'
}
