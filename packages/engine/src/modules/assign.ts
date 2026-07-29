import {
  otherSeat,
  type Action,
  type AssignSpec,
  type EventEnvelope,
  type ResolvedModule,
  type Seat,
} from '@banpick/types'

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

type AssignModule = AssignSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<AssignModule>

/**
 * D10 — round 1 is the mirror of round 0. No roll, no choice: **both** privileges invert.
 *
 * Inverting only the draft privilege would leave the round-0 winner holding turn order across
 * two consecutive rounds, so the alternation would not actually be symmetric. Inverting both
 * makes rounds 0 and 1 exactly symmetric across the seats, which is what lets round 2 be a
 * clean decider rather than a tiebreak weighted by everything before it.
 *
 * Nothing is decided here, so D13 would allow deriving it silently. It emits an event anyway —
 * see the ASSIGN arm in the event union for why §15 needs it written down.
 */
export const assign: PhaseModule<AssignModule> = {
  reads: [],
  writes: [],
  /** Only ever inserted by an override, never present to be removed. */
  essential: false,

  awaiting(): Seat[] {
    return []
  },

  legalActions(): Action[] {
    return []
  },

  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    const round = roundOf(state, mod)
    if (round.privilegeHolder !== null || round.turnOrderHolder !== null) return null

    const index = findRoundIndex(mod)
    const previous = state.rounds[index - 1]
    if (!previous) {
      throw new TypeError(`${mod.id}: INVERT_PREVIOUS has no round ${index - 1} to invert`)
    }

    return envelope(seq, `${mod.id}:assign`, 'SYSTEM', {
      type: 'ASSIGN',
      moduleId: mod.id,
      roundIndex: index,
      privilegeHolder: previous.privilegeHolder ? otherSeat(previous.privilegeHolder) : null,
      turnOrderHolder: previous.turnOrderHolder ? otherSeat(previous.turnOrderHolder) : null,
      reason: 'INVERTED',
    })
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload
    if (p.type !== 'ASSIGN') {
      return reject('WRONG_PHASE', `${mod.id} expects ASSIGN, got ${p.type}`)
    }
    const next = cloneState(state)
    const round = roundOf(next, mod)
    round.privilegeHolder = p.privilegeHolder
    round.turnOrderHolder = p.turnOrderHolder
    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    const round = roundOf(state, mod)
    return round.privilegeHolder !== null || round.turnOrderHolder !== null
  },
}
