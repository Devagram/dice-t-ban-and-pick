import type { CharId } from './character.js'
import type { MatchRule, Resolution } from './ruleset.js'

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
 * Regulation for a Bo3 (§10, D21), and **no longer the answer for every mode** — see D36.
 *
 * D30 adds a fourth *index* without adding a fourth regulation round: overtime sits one past the
 * end of regulation and is entered only when regulation ends level and both seats still hold an
 * unplayed character.
 *
 * Kept as a named constant because it is the number D21's argument is about, but nothing decides
 * anything with it any more. Everything that reasons about "how many rounds are left to win" asks
 * `regulationRounds(mode.match)`, which is the same 3 for every mode that says `ALWAYS_3_ROUNDS`
 * and is not 3 for one that does not. `MAX_ROUNDS` is the size of the array, a different question
 * again.
 */
export const ROUND_COUNT = 3

/** Regulation plus the optional overtime round (D30). The bound on `RoundIdx`. */
export const MAX_ROUNDS = 4

/**
 * D36 — regulation length, read off the mode instead of assumed.
 *
 * One table, deliberately: this is the only place that knows what a resolution *means*, so the
 * engine, the loader's termination check, and the projection cannot drift into three answers.
 */
export const REGULATION_ROUNDS: Record<Resolution, number> = {
  ALWAYS_1_ROUND: 1,
  ALWAYS_3_ROUNDS: ROUND_COUNT,
}

export function regulationRounds(match: MatchRule): number {
  return REGULATION_ROUNDS[match.resolution]
}

/** The index the overtime round sits at, which is one past the end of regulation (D30). */
export function overtimeRoundIndex(match: MatchRule): number {
  return regulationRounds(match)
}

export function isSlotIdx(n: number): n is SlotIdx {
  return Number.isInteger(n) && n >= 0 && n < MAX_DRAFT_COUNT
}

export function isRoundIdx(n: number): n is RoundIdx {
  return Number.isInteger(n) && n >= 0 && n < MAX_ROUNDS
}
