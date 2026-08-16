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
  /**
   * D28 — FORBIDDEN by default. You may not bring the same meta ban against the same person two
   * sets running.
   *
   * The first rule in the app that spans matches, which is why it needs saying in the ruleset
   * rather than being implicit: it changes what the joiner is consenting to when they sit down
   * (§12.3), and the pool it narrows is the one the whole mode turns on.
   */
  repeatBans: 'ALLOWED' | 'FORBIDDEN'
}

/** Spec §10, D21. One rule ships; the type keeps the door open for evidence to reopen it. */
export interface TieRule {
  scoring: 'HALF_POINT'
  /** D6 — a tie spends both characters. This is what makes HALF_POINT the natural default. */
  consumesCharacters: true
}

/**
 * How long regulation is (§10, D21) — **and D36 made this a real choice rather than a constant.**
 *
 * It was a single-member union, and three rounds were hardcoded into the engine beside it as
 * `ROUND_COUNT`. That was fine while every mode was a Bo3, and it quietly broke §1's promise that
 * "new modes must be config, never engine code" the moment one was not: a mode declaring a
 * one-round loop still got three round states allocated, two of which could never be played and
 * both of which reached the history page as blank rows.
 *
 * Enumerated rather than a plain number for two reasons. G14's termination check is a lookup over
 * `(scoring, resolution, overtime)` triples, and a triple with an open-ended integer in it is not
 * a table anyone can read and agree with. And `RoundIdx` is `0 | 1 | 2 | 3`, so the set of
 * lengths the state can actually address is small and finite — writing that down is more honest
 * than accepting any integer and failing at `createMatch`.
 */
export type Resolution = 'ALWAYS_1_ROUND' | 'ALWAYS_3_ROUNDS'

export interface MatchRule {
  resolution: Resolution
  /**
   * Skips a dead rubber. After two rounds only 2–0 is mathematically settled — at 1.5–0.5 a
   * draw is still reachable, so round 3 is played.
   *
   * Meaningless at `ALWAYS_1_ROUND`, where there is no rubber to skip. Left settable rather than
   * forbidden: a flag that is simply not consulted is easier to reason about than one whose legal
   * values depend on a sibling field.
   */
  stopWhenDecided: boolean
}

/**
 * **D38 — how a round result is agreed.**
 *
 * `ONE_SIDED` is D15 and stays the default: either seat reports, no confirmation. A confirm step
 * is ceremony against a trusted counterparty (§1), and the real failure mode is a fat finger,
 * which `UNDO_LAST_RESULT` covers.
 *
 * `BOTH_SEATS` reinstates the two-sided schema §17 withdrew — and it withdrew it *because* D19
 * ruled tournaments out, which D37 reverses. One-sided reporting is right between friends and
 * wrong when it eliminates somebody: a bracket advances on a result either player can enter alone
 * and either player can undo alone.
 *
 * On the ruleset rather than inferred from the tournament binding, so it is snapshotted into the
 * creation event like every other rule (§11 non-negotiable 2) and a replay a year later applies
 * what the match was actually played under.
 */
export type ResultReporting = 'ONE_SIDED' | 'BOTH_SEATS'

/**
 * D30 — the tiebreaker round.
 *
 * `HALF_POINT` scoring makes 1.5–1.5 reachable, and D21 accepted that as a legal draw because
 * three rounds against three characters leaves nothing to play. At `draftCount: 4` that stopped
 * being true: each seat finishes regulation holding one unplayed character, and the natural
 * decider was sitting on the board unused.
 *
 * Enabled is not the same as played. The round is entered only when regulation ends level *and*
 * both seats still hold an unconsumed character — so the same mode file covers `draftCount: 3`,
 * where it can never fire, without a branch.
 */
export interface OvertimeRule {
  enabled: boolean
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
  /** D38. `ONE_SIDED` unless a tournament opened this match. */
  resultReporting: ResultReporting
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
