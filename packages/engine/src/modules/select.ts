import {
  SEATS,
  type Action,
  type EventEnvelope,
  type ResolvedModule,
  type Seat,
  type SelectSpec,
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

type SelectModule = SelectSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<SelectModule>

/**
 * Spec §8 — "Commit a slot for the round. **Auto-commits when exactly one legal option
 * exists** (D26)."
 *
 * D26 is the rule that let `draftCount` become a parameter without putting an `if` inside mode
 * config. The rule was never *"round 2 is special"* — it is **"a decision with one option is
 * not a decision"** — so the same program serves both parameter values, and it also covers a
 * case nobody enumerated: at `draftCount: 3` a round-1 ban already leaves the opponent exactly
 * one option, so that select auto-commits too.
 *
 * No information leaks. The round loop runs only after every reveal gate has fired, so both
 * seats' holdings are already public when auto-commit becomes observable. Seeing an opponent
 * commit instantly tells you they were forced — which you knew, because you placed the ban
 * that forced them.
 */
export const select: PhaseModule<SelectModule> = {
  reads: ['slots'],
  writes: ['slots', 'selection'],
  /** Spends the slot. This is the module D13 was written about. */
  essential: true,

  awaiting({ state, mod }: Ctx): Seat[] {
    return actors(state, mod).filter((seat) => !hasSelected(state, mod, seat))
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (!actors(state, mod).includes(seat)) return []
    if (hasSelected(state, mod, seat)) return []

    const slots = legalSlots(state, mod, seat)
    // A forced select is not offered as an action — the system commits it. Surfacing a
    // one-option choice is exactly the dominated-action smell D11 removed from round 2.
    if (slots.length <= 1) return []

    return [
      {
        type: 'SELECT',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        slots: slots.map((s) => s.index),
      },
    ]
  },

  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    for (const seat of actors(state, mod)) {
      if (hasSelected(state, mod, seat)) continue
      const slots = legalSlots(state, mod, seat)
      if (slots.length !== 1) continue
      return envelope(seq, `${mod.id}:select:${seat}`, 'SYSTEM', {
        type: 'SELECT',
        moduleId: mod.id,
        roundIndex: findRoundIndex(mod),
        seat,
        slotIndex: slots[0]!.index,
        reason: 'FORCED',
      })
    }

    // Round 2's simultaneous hidden pick needs its own gate, on the same both-ready rule as
    // SIMULTANEOUS_COMMIT. A sequential select is public on placement and has nothing to open.
    if (mod.mode === 'SIMULTANEOUS_HIDDEN' && !revealed(state, mod)) {
      if (actors(state, mod).every((seat) => hasSelected(state, mod, seat))) {
        return envelope(seq, selectionRevealTag(mod), 'SYSTEM', {
          type: 'REVEAL',
          moduleId: mod.id,
          slices: ['selection'],
        })
      }
    }

    return null
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload

    if (p.type === 'REVEAL') {
      const next = cloneState(state)
      next.log.push(event)
      return { ok: true, state: next }
    }

    if (p.type !== 'SELECT') {
      return reject('WRONG_PHASE', `${mod.id} expects SELECT, got ${p.type}`)
    }
    if (!actors(state, mod).includes(p.seat)) {
      return reject('NOT_YOUR_TURN', `${mod.id} is not seat ${p.seat}'s selection`)
    }
    if (hasSelected(state, mod, p.seat)) {
      return reject('DUPLICATE_COMMIT', `seat ${p.seat} has already selected in ${mod.id}`)
    }

    const legal = legalSlots(state, mod, p.seat)
    if (!legal.some((s) => s.index === p.slotIndex)) {
      return reject('ILLEGAL_SLOT', `slot ${p.slotIndex} is not selectable this round`)
    }
    // A seat may not hand-author a FORCED select; that authorship is the system's claim that
    // no decision existed, and it has to stay trustworthy in the log.
    if (p.reason === 'FORCED' && event.actor !== 'SYSTEM') {
      return reject('ILLEGAL_OPTION', 'FORCED selections are authored by SYSTEM (D26)')
    }

    const next = cloneState(state)
    const round = roundOf(next, mod)

    // Sealed for a simultaneous hidden select (round 2), public for a sequential one.
    round.selection[p.seat] =
      mod.mode === 'SIMULTANEOUS_HIDDEN'
        ? { value: p.slotIndex, owner: p.seat, revealedBy: selectionRevealTag(mod) }
        : { value: p.slotIndex, owner: null, revealedBy: null }

    const slot = next.seats[p.seat].slots.value.find((s) => s.index === p.slotIndex)
    if (!slot) return reject('ILLEGAL_SLOT', `no slot ${p.slotIndex} on seat ${p.seat}`)
    slot.consumed = true

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    if (!actors(state, mod).every((seat) => hasSelected(state, mod, seat))) return false
    if (mod.mode === 'SIMULTANEOUS_HIDDEN') return revealed(state, mod)
    return true
  },
}

function selectionRevealTag(mod: SelectModule): string {
  return `${mod.id}:reveal`
}

function revealed(state: Ctx['state'], mod: SelectModule): boolean {
  return state.log.some((e) => e.tag === selectionRevealTag(mod))
}

function actors(state: Ctx['state'], mod: SelectModule): Seat[] {
  return mod.actor === 'BOTH' ? [...SEATS] : resolveActor(state, mod, mod.actor)
}

function legalSlots(state: Ctx['state'], mod: SelectModule, seat: Seat) {
  return slotPool(mod.pool, {
    state,
    seat,
    slotIndex: null,
    roundIndex: findRoundIndex(mod),
  })
}

function hasSelected(state: Ctx['state'], mod: SelectModule, seat: Seat): boolean {
  return state.log.some(
    (e) => e.payload.type === 'SELECT' && e.payload.moduleId === mod.id && e.payload.seat === seat,
  )
}
