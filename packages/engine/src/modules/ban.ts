import {
  otherSeat,
  type Action,
  type BanSpec,
  type EventEnvelope,
  type ResolvedModule,
  type Seat,
} from '@banpick/types'

import { slotPool } from '../pools.js'
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

type BanModule = BanSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<BanModule>

/**
 * Spec §8 — "Place a ban of a given tier." The shipped modes use the round tier only; global
 * bans live on the ruleset and meta bans are placed inside SIMULTANEOUS_COMMIT.
 *
 * D3: a round ban targets a specific opponent **slot**, not a character, and it is
 * round-scoped. Two consequences the slot addressing buys directly — the banner may play the
 * same character they just banned, and with cross-seat mirrors allowed (D1) a character ID
 * would not have identified a unique target anyway.
 */
export const ban: PhaseModule<BanModule> = {
  reads: ['slots'],
  writes: ['slots'],
  /** D11 — round 2 has no ban. Removing it leaves no transition unmade. */
  essential: false,

  awaiting({ state, mod }: Ctx): Seat[] {
    if (placed(state, mod)) return []
    return resolveActor(state, mod, mod.actor)
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (placed(state, mod)) return []
    if (!resolveActor(state, mod, mod.actor).includes(seat)) return []

    const targets = slotPool(mod.pool, {
      state,
      seat,
      slotIndex: null,
      roundIndex: findRoundIndex(mod),
    })

    return [
      {
        type: 'BAN',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        tier: mod.tier,
        targets: targets.map((slot) => ({ seat: otherSeat(seat), slotIndex: slot.index })),
      },
    ]
  },

  systemEvent(): EventEnvelope | null {
    return null
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload
    if (p.type !== 'BAN') {
      return reject('WRONG_PHASE', `${mod.id} expects BAN, got ${p.type}`)
    }
    if (!resolveActor(state, mod, mod.actor).includes(p.seat)) {
      return reject('NOT_YOUR_TURN', `${mod.id} is not seat ${p.seat}'s ban`)
    }
    if (p.target.seat !== otherSeat(p.seat)) {
      return reject('ILLEGAL_TARGET', 'a round ban targets an opponent slot (D3)')
    }

    const legal = slotPool(mod.pool, {
      state,
      seat: p.seat,
      slotIndex: null,
      roundIndex: findRoundIndex(mod),
    })
    if (!legal.some((slot) => slot.index === p.target.slotIndex)) {
      return reject('ILLEGAL_TARGET', `slot ${p.target.slotIndex} is not a legal ban target`)
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)
    const targetSlots = next.seats[p.target.seat].slots.value
    const slot = targetSlots.find((s) => s.index === p.target.slotIndex)
    if (!slot)
      return reject('ILLEGAL_TARGET', `no slot ${p.target.slotIndex} on seat ${p.target.seat}`)

    // Round-scoped (D3): the denial is recorded against the round index, not cleared later.
    // That keeps the transition monotonic, which is the invariant D21 protected by cutting
    // VOID_AND_REPLAY.
    slot.bannedInRound = findRoundIndex(mod)
    round.ban = { by: p.seat, target: p.target }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return placed(state, mod)
  },
}

function placed(state: Ctx['state'], mod: BanModule): boolean {
  return state.log.some((e) => e.payload.type === 'BAN' && e.payload.moduleId === mod.id)
}
