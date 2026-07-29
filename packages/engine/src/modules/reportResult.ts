import {
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
 * D15 accordingly: either seat reports, no confirmation. A confirm step is ceremony against a
 * trusted counterparty (§1), and the real failure mode is a fat finger, which `UNDO_LAST_RESULT`
 * covers. `reportedBy` stays in the log for attribution, which is useful in casual play for its
 * own sake — not because a `DISPUTE` state is coming (D19 ruled that out).
 */
export const reportResult: PhaseModule<ReportModule> = {
  reads: [],
  writes: [],
  /** Produces the result the match rule scores. Without it nothing terminates. */
  essential: true,

  awaiting({ state, mod }: Ctx): Seat[] {
    return reported(state, mod) ? [] : [...SEATS]
  },

  legalActions({ state, mod }: Ctx, _seat: Seat): Action[] {
    if (reported(state, mod)) return []
    const outcomes: RoundOutcome[] = mod.allowTie ? ['A', 'B', 'TIE'] : ['A', 'B']
    return [
      {
        type: 'REPORT_RESULT',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        outcomes,
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
    if (reported(state, mod)) {
      return reject('DUPLICATE_COMMIT', `round ${mod.roundIndex} is already reported`)
    }
    if (p.outcome === 'TIE' && !mod.allowTie) {
      return reject('ILLEGAL_OPTION', `${mod.id} does not allow ties`)
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)
    round.result = p.outcome
    applyScore(next, p.outcome, +1)

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return reported(state, mod)
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

function reported(state: Ctx['state'], mod: ReportModule): boolean {
  return (
    state.rounds[findRoundIndex(mod)]?.result !== null &&
    state.rounds[findRoundIndex(mod)]?.result !== undefined
  )
}
