import {
  SEATS,
  type Action,
  type EventEnvelope,
  type ResolvedModule,
  type RollSpec,
  type Seat,
} from '@banpick/types'

import { rollDice } from '../rng.js'
import {
  cloneState,
  envelope,
  findRoundIndex,
  reject,
  roundOf,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'

type RollModule = RollSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<RollModule>

/**
 * Spec §8 — "Server-side dice with resolution and tie policy." §11 makes the Durable Object the
 * authority for all dice; the engine makes them a pure function of `(seed, seq, actor, attempt)`
 * so that authority is auditable rather than merely trusted.
 *
 * `onTie: REROLL` advances `attempt` rather than consuming stream state, so the reroll replays
 * as exactly as the roll it replaced.
 *
 * **Both players have to ask for it.** The dice are the server's and always were — the outcome is
 * fixed by `(seed, seq, actor, attempt)` before anyone clicks — but the round used to throw them
 * the instant it opened, which made the most dramatic moment in a match something that happened
 * *at* the players rather than between them. A `ROLL_READY` from each seat gates it. Nothing
 * about the result depends on the clicks; only the timing does, and timing is the whole point.
 */
export const roll: PhaseModule<RollModule> = {
  reads: [],
  writes: [],
  /** D10 — round 1 removes it, and correctly: nothing is left undecided. */
  essential: false,

  awaiting({ state, mod }: Ctx): Seat[] {
    if (roundOf(state, mod).roll !== null) return []
    return SEATS.filter((s) => !hasReadied(state, mod.id, s))
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (roundOf(state, mod).roll !== null) return []
    if (hasReadied(state, mod.id, seat)) return []
    return [{ type: 'ROLL', moduleId: mod.id, roundIndex: findRoundIndex(mod) }]
  },

  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    if (roundOf(state, mod).roll !== null) return null
    // Nothing happens until both seats have asked. The dice were decided long before either of
    // them did, but they are not *shown* until the table agrees to look.
    if (!SEATS.every((s) => hasReadied(state, mod.id, s))) return null

    // REROLL is unbounded in the spec. It terminates with probability 1 and, at 1d6, the
    // chance of reaching 64 consecutive ties is about 10^-50 — but an unbounded loop inside a
    // reducer is a hang, not a bug report, so it is capped and made loud.
    //
    // Every throw is kept, not just the last. A tie happens about one roll in six at 1d6, and
    // it is the moment worth watching; an event that recorded only the winner would leave the
    // client narrating "after 2 attempts" over a story it cannot tell.
    const throws: Record<Seat, number>[] = []
    let attempt = 0
    let a: number
    let b: number
    do {
      a = rollDice({ seed: state.seed, seq, actor: 'A', attempt }, mod.dice.count, mod.dice.sides)
      b = rollDice({ seed: state.seed, seq, actor: 'B', attempt }, mod.dice.count, mod.dice.sides)
      throws.push({ A: a, B: b })
      attempt++
    } while (a === b && attempt < 64)

    if (a === b) throw new Error('roll: reroll limit reached — the RNG is not behaving')

    return envelope(seq, `${mod.id}:roll`, 'SYSTEM', {
      type: 'ROLL',
      moduleId: mod.id,
      roundIndex: findRoundIndex(mod),
      results: { A: a, B: b },
      attempts: attempt,
      throws,
      winner: a > b ? 'A' : 'B',
      assigns: mod.assigns,
    })
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload

    // A seat asking for the dice. Recorded and nothing more — the roll itself is a SYSTEM event
    // that `systemStep` emits once both are in, which keeps `reduce` single-event and keeps the
    // RNG out of a player-authored payload.
    if (p.type === 'ROLL_READY') {
      if (roundOf(state, mod).roll !== null) {
        return reject('WRONG_PHASE', `${mod.id} has already rolled`)
      }
      if (hasReadied(state, mod.id, p.seat)) {
        return reject('DUPLICATE_COMMIT', `${p.seat} has already asked to roll`)
      }
      const next = cloneState(state)
      next.log.push(event)
      return { ok: true, state: next }
    }

    if (p.type !== 'ROLL') {
      return reject('WRONG_PHASE', `${mod.id} expects ROLL, got ${p.type}`)
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)
    round.roll = {
      results: p.results,
      winner: p.winner,
      attempts: p.attempts,
      // Tolerates a log written before `throws` existed: an older event replays with the final
      // result as its only throw, which is exactly what it recorded.
      throws: p.throws ?? [p.results],
    }

    // D11 — in round 2 the roll assigns turn order directly. There is no draft privilege left
    // to alternate, and a CHOOSE with one real option is a dominated action wearing a costume.
    if (p.assigns === 'TURN_ORDER') {
      round.turnOrderHolder = p.winner
    }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return roundOf(state, mod).roll !== null
  },
}

/** Has this seat asked for the dice on this module? */
function hasReadied(state: Ctx['state'], moduleId: string, seat: Seat): boolean {
  return state.log.some(
    (e) =>
      e.payload.type === 'ROLL_READY' && e.payload.moduleId === moduleId && e.payload.seat === seat,
  )
}
