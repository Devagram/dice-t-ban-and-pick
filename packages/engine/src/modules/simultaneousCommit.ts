import {
  SEATS,
  isSlotIdx,
  type Action,
  type CharId,
  type EventEnvelope,
  type ResolvedSimultaneousCommit,
  type Seat,
  type Slot,
} from '@banpick/types'

import { charPool } from '../pools.js'
import {
  envelope,
  cloneState,
  reject,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'
import { revealTag } from '../resolveMode.js'

type Ctx = ModuleCtx<ResolvedSimultaneousCommit>

/**
 * Spec §8 — "Both seats submit hidden, reveal on both-ready. Used by draft, meta ban, and
 * repick. Write this once."
 *
 * The commit is sealed with the tag that will open it (`revealTags`, bound at resolution), so
 * `project` never has to ask *when* a slice opens — only whether the tag has landed.
 */
export const simultaneousCommit: PhaseModule<ResolvedSimultaneousCommit> = {
  reads: [],
  writes: ['slots', 'metaBan'],
  /** The draft is where slots come from; with none, nothing can be selected. */
  essential: true,

  awaiting({ state, mod }: Ctx): Seat[] {
    return SEATS.filter((s) => !hasCommitted(state, s, mod.id))
  },

  legalActions({ state, mod }: Ctx, seat: Seat): Action[] {
    if (hasCommitted(state, seat, mod.id)) return []

    const picks = mod.commits.picks
    const metaBan = mod.commits.metaBan

    return [
      {
        type: 'COMMIT',
        moduleId: mod.id,
        picks: picks
          ? {
              count: picks.count,
              // One pool per slot. D12 excludes what the seat holds in its *other* slots, so
              // the pools differ between slots as a draft is assembled — which is exactly why
              // §6 makes the expression slot-indexed rather than seat-indexed.
              poolBySlot: Array.from({ length: picks.count }, (_, i) =>
                charPool(picks.pool, {
                  state,
                  seat,
                  slotIndex: isSlotIdx(i) ? i : null,
                  roundIndex: null,
                }),
              ),
            }
          : null,
        metaBan: metaBan
          ? {
              count: 1,
              pool: charPool(metaBan.pool, { state, seat, slotIndex: null, roundIndex: null }),
            }
          : null,
      },
    ]
  },

  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    if (!SEATS.every((s) => hasCommitted(state, s, mod.id))) return null

    const slices = revealedNow(mod)
    if (slices.length === 0) return null

    // Already revealed? The reveal event carries this module's tag exactly once.
    const tag = revealTag(mod.id)
    if (state.log.some((e) => e.tag === tag)) return null

    return envelope(seq, tag, 'SYSTEM', { type: 'REVEAL', moduleId: mod.id, slices })
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    const p = event.payload

    if (p.type === 'REVEAL') {
      const next = cloneState(state)
      next.log.push(event)
      // metaBannedAgainst is derived: my ban denies characters to my *opponent* (D4).
      if (p.slices.includes('metaBan')) {
        for (const seat of SEATS) {
          const ban = next.seats[seat].metaBanPlaced.value
          if (ban !== null) {
            const target = seat === 'A' ? 'B' : 'A'
            if (!next.metaBannedAgainst[target].includes(ban)) {
              next.metaBannedAgainst[target].push(ban)
            }
          }
        }
      }
      return { ok: true, state: next }
    }

    if (p.type !== 'COMMIT') {
      return reject('WRONG_PHASE', `${mod.id} expects COMMIT, got ${p.type}`)
    }
    if (hasCommitted(state, p.seat, mod.id)) {
      return reject('DUPLICATE_COMMIT', `seat ${p.seat} has already committed to ${mod.id}`)
    }

    const picksSpec = mod.commits.picks
    const metaBanSpec = mod.commits.metaBan

    if (picksSpec === null && p.picks.length > 0) {
      return reject('WRONG_COMMIT_SHAPE', `${mod.id} declares no picks`)
    }
    if (metaBanSpec === null && p.metaBan !== null) {
      return reject('WRONG_COMMIT_SHAPE', `${mod.id} declares no meta ban`)
    }

    if (picksSpec) {
      if (p.picks.length !== picksSpec.count) {
        return reject(
          'WRONG_COMMIT_SHAPE',
          `${mod.id} expects ${picksSpec.count} picks, got ${p.picks.length}`,
        )
      }
      for (let i = 0; i < p.picks.length; i++) {
        const id = p.picks[i]!
        const slotIndex = isSlotIdx(i) ? i : null
        if (slotIndex === null) {
          return reject('ILLEGAL_SLOT', `slot index ${i} is out of range`)
        }
        // D12 lands here without a special case: the character must be in the pool for *this*
        // slot, and the pool for this slot excludes what the other slots already hold.
        const pool = charPool(picksSpec.pool, {
          state,
          seat: p.seat,
          slotIndex,
          roundIndex: null,
        })
        const held = p.picks.filter((_, j) => j !== i)
        const legal =
          pool.includes(id) &&
          (state.ruleset.constraints.selfDuplicates === 'ALLOWED' || !held.includes(id))
        if (!legal) {
          return reject('ILLEGAL_CHARACTER', `${id} is not in the pool for slot ${i}`)
        }
      }
    }

    if (metaBanSpec) {
      if (p.metaBan === null) {
        return reject('WRONG_COMMIT_SHAPE', `${mod.id} requires a meta ban`)
      }
      const pool = charPool(metaBanSpec.pool, {
        state,
        seat: p.seat,
        slotIndex: null,
        roundIndex: null,
      })
      if (!pool.includes(p.metaBan)) {
        return reject('ILLEGAL_CHARACTER', `${p.metaBan} is not a legal meta ban target`)
      }
    }

    const next = cloneState(state)
    const seatState = next.seats[p.seat]

    if (picksSpec) {
      seatState.slots = {
        value: p.picks.map(toSlot),
        owner: p.seat,
        revealedBy: mod.revealTags.picks,
      }
    }
    if (metaBanSpec) {
      seatState.metaBanPlaced = {
        value: p.metaBan,
        owner: p.seat,
        revealedBy: mod.revealTags.metaBan,
      }
    }

    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    if (!SEATS.every((s) => hasCommitted(state, s, mod.id))) return false
    if (revealedNow(mod).length === 0) return true
    return state.log.some((e) => e.tag === revealTag(mod.id))
  },
}

/**
 * Has this seat committed **to this module**?
 *
 * The `moduleId` check is load-bearing and was not always here. While every mode had exactly one
 * commit, "has this seat committed" and "has this seat committed to this module" were the same
 * question, so the log search omitted the id. `bring-ban1` then split into two commits — ban,
 * then draft — and the ban silently satisfied the draft's completion check: both seats banned,
 * the draft module declared itself finished, and the match skipped the entire draft to arrive at
 * round one with empty rosters.
 *
 * The general shape: a predicate that reads the whole log has to say which part of it it means.
 */
function hasCommitted(state: Ctx['state'], seat: Seat, moduleId: string): boolean {
  return state.log.some(
    (e) =>
      e.payload.type === 'COMMIT' &&
      e.payload.moduleId === moduleId &&
      e.payload.seat === seat &&
      e.actor === seat,
  )
}

/** Which of this module's slices open at its own gate. DEFERRED ones wait for a REVEAL. */
function revealedNow(mod: ResolvedSimultaneousCommit) {
  const slices: ('slots' | 'metaBan')[] = []
  if (mod.commits.picks && mod.reveal.picks === 'IMMEDIATE') slices.push('slots')
  if (mod.commits.metaBan && mod.reveal.metaBan === 'IMMEDIATE') slices.push('metaBan')
  return slices
}

function toSlot(characterId: CharId, index: number): Slot {
  if (!isSlotIdx(index)) throw new RangeError(`slot index ${index} out of range`)
  return { index, characterId, consumed: false, bannedInRound: null }
}
