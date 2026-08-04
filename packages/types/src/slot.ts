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

export type RoundIdx = 0 | 1 | 2 | 3

/**
 * Regulation (§10, D21). Three rounds are always played, subject to `stopWhenDecided`.
 *
 * D30 adds a fourth *index* without adding a fourth regulation round: overtime sits at index 3
 * and is entered only when regulation ends level and both seats still hold an unplayed
 * character. Everything that reasons about "how many rounds are left to win" means this number,
 * so it stays 3 — `MAX_ROUNDS` is the size of the array, which is a different question.
 */
export const ROUND_COUNT = 3

/** Regulation plus the optional overtime round (D30). The bound on `RoundIdx`. */
export const MAX_ROUNDS = 4

export function isSlotIdx(n: number): n is SlotIdx {
  return Number.isInteger(n) && n >= 0 && n < MAX_DRAFT_COUNT
}

export function isRoundIdx(n: number): n is RoundIdx {
  return Number.isInteger(n) && n >= 0 && n < MAX_ROUNDS
}
