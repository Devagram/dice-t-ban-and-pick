import {
  SEATS,
  type Action,
  type EventEnvelope,
  type ResolvedConditionalRecommit,
  type Seat,
} from '@banpick/types'

import { charPool, slotPool } from '../pools.js'
import {
  cloneState,
  reject,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'

type Ctx = ModuleCtx<ResolvedConditionalRecommit>

/**
 * Spec §8 — "Replace slots matching a trigger predicate, hidden."
 *
 * `bring-ban1`'s repick. A seat whose slot holds a character the opponent's meta ban denied
 * replaces exactly those slots, and only those. A seat the ban missed acts trivially — which
 * is the common case at a 75-character roster (O6: the ban whiffs about nineteen times in
 * twenty under uniform drafting).
 */
export const conditionalRecommit: PhaseModule<ResolvedConditionalRecommit> = {
  reads: ['slots', 'metaBan'],
  writes: ['slots'],
  /** A repick is conditional by construction — a ban that misses triggers nothing. */
  essential: false,

  awaiting({ state }: Ctx): Seat[] {
    return SEATS.filter((s) => triggered(state, s).length > 0 && !hasRecommitted(state, s))
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (hasRecommitted(state, seat)) return []
    const slots = triggered(state, seat)
    if (slots.length === 0) return []

    return [
      {
        type: 'RECOMMIT',
        moduleId: mod.id,
        slots: slots.map((slot) => ({
          index: slot.index,
          // §6: "during a CONDITIONAL_RECOMMIT a slot must not exclude the character it
          // currently holds" — which the slot-indexed pool already handles, because
          // SELF_HELD_OTHER_SLOTS skips this slot. The banned character is excluded anyway,
          // by META_BANNED_AGAINST, so the repick cannot re-select what triggered it.
          pool: charPool(mod.pool, { state, seat, slotIndex: slot.index, roundIndex: null }),
        })),
      },
    ]
  },

  systemEvent(): EventEnvelope | null {
    return null
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload
    if (p.type !== 'RECOMMIT') {
      return reject('WRONG_PHASE', `${mod.id} expects RECOMMIT, got ${p.type}`)
    }
    if (hasRecommitted(state, p.seat)) {
      return reject('DUPLICATE_COMMIT', `seat ${p.seat} has already recommitted`)
    }

    const required = triggered(state, p.seat).map((s) => s.index)
    const offered = p.replacements.map((r) => r.index)
    if (required.length !== offered.length || !required.every((i) => offered.includes(i))) {
      return reject(
        'WRONG_COMMIT_SHAPE',
        `${mod.id} triggers on slots [${required.join(',')}], got [${offered.join(',')}]`,
      )
    }

    for (const r of p.replacements) {
      const pool = charPool(mod.pool, {
        state,
        seat: p.seat,
        slotIndex: r.index,
        roundIndex: null,
      })
      if (!pool.includes(r.characterId)) {
        return reject('ILLEGAL_CHARACTER', `${r.characterId} is not legal for slot ${r.index}`)
      }
      // D12 again, and this is the case the naive reading gets wrong: the pool for slot i
      // excludes the *other* slots' characters, but two replacements in one submission must
      // also not collide with each other.
      const others = p.replacements.filter((o) => o.index !== r.index)
      if (
        state.ruleset.constraints.selfDuplicates === 'FORBIDDEN' &&
        others.some((o) => o.characterId === r.characterId)
      ) {
        return reject('ILLEGAL_CHARACTER', `${r.characterId} would duplicate within the recommit`)
      }
    }

    const next = cloneState(state)
    const seatState = next.seats[p.seat]
    const slots = seatState.slots.value.map((slot) => {
      const replacement = p.replacements.find((r) => r.index === slot.index)
      return replacement ? { ...slot, characterId: replacement.characterId } : slot
    })
    seatState.slots = {
      value: slots,
      owner: p.seat,
      revealedBy: mod.hidden ? mod.revealTag : seatState.slots.revealedBy,
    }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state }: Ctx): boolean {
    return SEATS.every((s) => triggered(state, s).length === 0 || hasRecommitted(state, s))
  },
}

function triggered(state: Ctx['state'], seat: Seat) {
  return slotPool('repickTrigger', { state, seat, slotIndex: null, roundIndex: null })
}

function hasRecommitted(state: Ctx['state'], seat: Seat): boolean {
  return state.log.some((e) => e.payload.type === 'RECOMMIT' && e.payload.seat === seat)
}
