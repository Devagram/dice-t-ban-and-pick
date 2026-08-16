import {
  otherSeat,
  SEATS,
  type Action,
  type BanSpec,
  type EventEnvelope,
  type ResolvedModule,
  type Seat,
} from '@banpick/types'

import { slotPool } from '../pools.js'
import {
  cloneState,
  envelope,
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
 *
 * **D36 — both seats may now ban in the same round.** The module was written around a single
 * banner: it recorded one `{ by, target }` on the round and treated "a BAN event exists for this
 * module" as done, so a second seat's ban had nowhere to go and would never have been asked for.
 * It now tracks per seat, exactly like `SELECT` — which is not a coincidence but the same
 * problem, and copying its shape is cheaper than inventing a second one that behaves subtly
 * differently under D15's undo.
 *
 * The hidden variant seals each ban to its placer until both are in. That sealing is only half
 * the guarantee: the visible *effect* of a ban is `bannedInRound` on an opponent slot, and
 * `slots` is public, so `project` masks the flag behind this same reveal. See `maskBanned`.
 */
export const ban: PhaseModule<BanModule> = {
  reads: ['slots'],
  writes: ['slots'],
  /** D11 — round 2 has no ban. Removing it leaves no transition unmade. */
  essential: false,

  awaiting({ state, mod }: Ctx): Seat[] {
    return actors(state, mod).filter((seat) => !hasBanned(state, mod, seat))
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (!actors(state, mod).includes(seat)) return []
    if (hasBanned(state, mod, seat)) return []

    const targets = legalTargets(state, mod, seat)
    if (targets.length === 0) return []

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

  /**
   * The reveal gate, on the same both-ready rule as SIMULTANEOUS_COMMIT and the hidden select.
   *
   * A sequential ban is public the moment it lands and has nothing to open, so it emits nothing
   * here — which also keeps the log of every existing Bo3 byte-identical to what it was.
   */
  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    if (mod.mode !== 'SIMULTANEOUS_HIDDEN' || revealed(state, mod)) return null
    if (!actors(state, mod).every((seat) => hasBanned(state, mod, seat))) return null

    return envelope(seq, banRevealTag(mod), 'SYSTEM', {
      type: 'REVEAL',
      moduleId: mod.id,
      slices: ['slots'],
    })
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload

    if (p.type === 'REVEAL') {
      const next = cloneState(state)
      next.log.push(event)
      return { ok: true, state: next }
    }

    if (p.type !== 'BAN') {
      return reject('WRONG_PHASE', `${mod.id} expects BAN, got ${p.type}`)
    }
    if (!actors(state, mod).includes(p.seat)) {
      return reject('NOT_YOUR_TURN', `${mod.id} is not seat ${p.seat}'s ban`)
    }
    if (hasBanned(state, mod, p.seat)) {
      return reject('DUPLICATE_COMMIT', `seat ${p.seat} has already banned in ${mod.id}`)
    }
    if (p.target.seat !== otherSeat(p.seat)) {
      return reject('ILLEGAL_TARGET', 'a round ban targets an opponent slot (D3)')
    }

    const legal = legalTargets(state, mod, p.seat)
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
    // Sealed for a hidden ban, public for a sequential one — the same distinction `SELECT` draws,
    // and the reason `RoundState.ban` is a slice at all.
    round.ban[p.seat] =
      mod.mode === 'SIMULTANEOUS_HIDDEN'
        ? { value: p.target.slotIndex, owner: p.seat, revealedBy: banRevealTag(mod) }
        : { value: p.target.slotIndex, owner: null, revealedBy: null }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    if (!actors(state, mod).every((seat) => hasBanned(state, mod, seat))) return false
    if (mod.mode === 'SIMULTANEOUS_HIDDEN') return revealed(state, mod)
    return true
  },
}

function banRevealTag(mod: BanModule): string {
  return `${mod.id}:reveal`
}

function revealed(state: Ctx['state'], mod: BanModule): boolean {
  return state.log.some((e) => e.tag === banRevealTag(mod))
}

function actors(state: Ctx['state'], mod: BanModule): Seat[] {
  return mod.actor === 'BOTH' ? [...SEATS] : resolveActor(state, mod, mod.actor)
}

function legalTargets(state: Ctx['state'], mod: BanModule, seat: Seat) {
  return slotPool(mod.pool, {
    state,
    seat,
    slotIndex: null,
    roundIndex: findRoundIndex(mod),
  })
}

function hasBanned(state: Ctx['state'], mod: BanModule, seat: Seat): boolean {
  return state.log.some(
    (e) => e.payload.type === 'BAN' && e.payload.moduleId === mod.id && e.payload.seat === seat,
  )
}
