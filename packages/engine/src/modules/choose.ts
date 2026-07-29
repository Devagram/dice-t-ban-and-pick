import {
  otherSeat,
  type Action,
  type ChooseSpec,
  type EventEnvelope,
  type ResolvedModule,
  type Seat,
} from '@banpick/types'

import {
  cloneState,
  findRoundIndex,
  reject,
  resolveActor,
  roundOf,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'

type ChooseModule = ChooseSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<ChooseModule>

/**
 * Spec §8 — "Actor picks from an option set, loser receives the complement."
 *
 * Two different jobs in the shipped modes, both genuinely a CHOOSE:
 *
 *   - **The round-0 privilege choice** (D2). Under D10 this is no longer "which privilege do I
 *     want" but "the weaker one now, or the stronger one next round" — see O5. The engine does
 *     not care; that is a balance question, and §15 is where it gets answered.
 *   - **`declareOrder`** (D23/D24). The turn-order holder declares play order *after* both
 *     selections are revealed, and may put themselves second. Declaring it blind would be a
 *     coin flip with ceremony.
 */
export const choose: PhaseModule<ChooseModule> = {
  reads: [],
  writes: [],
  /** D11 — round 2 removes it, because no draft privilege exists to choose. */
  essential: false,

  awaiting({ state, mod }: Ctx): Seat[] {
    if (decided(state, mod)) return []
    return resolveActor(state, mod, mod.actor)
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (decided(state, mod)) return []
    if (!resolveActor(state, mod, mod.actor).includes(seat)) return []
    return [
      {
        type: 'CHOOSE',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        options: mod.options,
      },
    ]
  },

  systemEvent(): EventEnvelope | null {
    return null
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload
    if (p.type !== 'CHOOSE') {
      return reject('WRONG_PHASE', `${mod.id} expects CHOOSE, got ${p.type}`)
    }
    if (!resolveActor(state, mod, mod.actor).includes(p.seat)) {
      return reject('NOT_YOUR_TURN', `${mod.id} is not seat ${p.seat}'s decision`)
    }
    if (!mod.options.includes(p.option)) {
      return reject('ILLEGAL_OPTION', `${p.option} is not offered by ${mod.id}`)
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)
    const opponent = otherSeat(p.seat)

    switch (p.option) {
      // D2 — the roll winner takes one privilege, the loser receives the complement.
      case 'DRAFT_PRIVILEGE':
        round.privilegeHolder = p.seat
        if (mod.loserGets === 'COMPLEMENT') round.turnOrderHolder = opponent
        break
      case 'TURN_ORDER':
        round.turnOrderHolder = p.seat
        if (mod.loserGets === 'COMPLEMENT') round.privilegeHolder = opponent
        break
      // D23 — the right to *decide* play order, not automatic first play.
      case 'SELF_FIRST':
        round.playOrder = { declaredBy: p.seat, first: p.seat }
        break
      case 'OPPONENT_FIRST':
        round.playOrder = { declaredBy: p.seat, first: opponent }
        break
    }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return decided(state, mod)
  },
}

function decided(state: Ctx['state'], mod: ChooseModule): boolean {
  return state.log.some((e) => e.payload.type === 'CHOOSE' && e.payload.moduleId === mod.id)
}
