import type { CharId } from './character.js'

/**
 * Spec §5. Picks are an **ordered slot array, not a set** — slots are the addressable ban
 * target, and character IDs are not unique within a match once cross-seat mirrors are allowed
 * (D1).
 *
 * The range is 0–3 because `draftCount` is 3 or 4 (D25). The spec originally declared
 * `0 | 1 | 2`, which predates D22.
 */
export type SlotIdx = 0 | 1 | 2 | 3

export const MAX_DRAFT_COUNT = 4

export interface Slot {
  /** Stable address. A round ban targets this, not the character sitting in it (D3). */
  index: SlotIdx
  characterId: CharId
  /** Spent, including on a tied round (D6). Monotonic — it never moves back (D21). */
  consumed: boolean
  /** Round-scoped denial (D3). Cleared conceptually by round index, not by mutation. */
  bannedInRound: RoundIdx | null
}

export type RoundIdx = 0 | 1 | 2

export const ROUND_COUNT = 3

export function isSlotIdx(n: number): n is SlotIdx {
  return Number.isInteger(n) && n >= 0 && n < MAX_DRAFT_COUNT
}

export function isRoundIdx(n: number): n is RoundIdx {
  return Number.isInteger(n) && n >= 0 && n < ROUND_COUNT
}
