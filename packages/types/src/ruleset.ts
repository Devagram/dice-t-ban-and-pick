import type { CharId } from './character.js'

/**
 * Spec §5. Both flags live on the ruleset so they are **snapshotted at match creation**
 * (§11 non-negotiable 2) rather than read live from a mode file that may since have changed.
 */
export interface DraftConstraints {
  /** D1 — ALLOWED. Drafting denies nothing; bans are the only denial mechanism. */
  crossSeatMirrors: 'ALLOWED' | 'FORBIDDEN'
  /** D12 — FORBIDDEN. Caps meta ban blast radius at one slot and makes the §13 floor derivable. */
  selfDuplicates: 'ALLOWED' | 'FORBIDDEN'
}

/** Spec §10, D21. One rule ships; the type keeps the door open for evidence to reopen it. */
export interface TieRule {
  scoring: 'HALF_POINT'
  /** D6 — a tie spends both characters. This is what makes HALF_POINT the natural default. */
  consumesCharacters: true
}

export interface MatchRule {
  resolution: 'ALWAYS_3_ROUNDS'
  /**
   * Skips a dead rubber. After two rounds only 2–0 is mathematically settled — at 1.5–0.5 a
   * draw is still reachable, so round 3 is played.
   */
  stopWhenDecided: boolean
}

export interface OvertimeRule {
  enabled: false
}

/**
 * Spec §5. Snapshotted into the creation event and never dereferenced afterwards.
 *
 * Everything a joiner must see before seating (§12.3) is on this object, because seating is
 * the consent and a summary is not consent.
 */
export interface Ruleset {
  modeId: string
  /** D25. Resolved host choices, e.g. `{ draftCount: 4 }`. */
  parameters: Record<string, string | number>
  rosterVersion: string
  /** Host-set, public, applies before everything (D5). Was `tournamentBanned` before D19. */
  globalBanned: CharId[]
  constraints: DraftConstraints
  onTie: TieRule
  match: MatchRule
  overtime: OvertimeRule
  /**
   * D20. Hash of the resolved mode definition **and** the resolved parameters — the same file
   * at `draftCount` 3 and 4 is two different rulesets. Lives in the creation event, never in
   * a URL.
   */
  modeContentHash: string
}

/** D25. The only parameter declared today; the shape generalizes. */
export const DRAFT_COUNT_VALUES = [3, 4] as const
export type DraftCount = (typeof DRAFT_COUNT_VALUES)[number]
