import type { ChoiceOption, EventTag } from './event.js'
import type { RoundIdx } from './slot.js'
import type { SliceName } from './slice.js'
import type { MatchRule, OvertimeRule, TieRule } from './ruleset.js'

/** Spec §8. A mode is an ordered list of these; adding a mode must never require new engine code. */
export type ModuleType =
  | 'SIMULTANEOUS_COMMIT'
  | 'CONDITIONAL_RECOMMIT'
  | 'REVEAL'
  | 'ROLL'
  | 'CHOOSE'
  | 'ASSIGN'
  | 'BAN'
  | 'SELECT'
  | 'REPORT_RESULT'
  | 'ROUND_LOOP'

/** Spec §6. Every draft rule is one of these set expressions, resolved against a seat. */
export type PoolName =
  'legalDraftPool' | 'legalMetaBanPool' | 'legalRoundBan' | 'legalRoundPick' | 'repickTrigger'

/**
 * Who acts, named relatively so the round template is written once and the overrides only
 * have to move the assignment.
 */
export type ActorRef = 'rollWinner' | 'privilegeHolder' | 'turnOrderHolder' | 'opponent' | 'BOTH'

export interface DiceSpec {
  count: number
  sides: number
}

// --- Module specifications ------------------------------------------------------------------
//
// Every module carries an `id`. This is stricter than spec §9.1's YAML, which gives ids only
// where it needs to refer back to one — and that turns out to be load-bearing: the round-2
// override says `remove: [CHOOSE, BAN]`, but the template holds *two* CHOOSE modules (the
// privilege choice and D24's `declareOrder`). Removing by type would delete the wrong one.
// Removing by id cannot. Phase 2's YAML schema should require ids for the same reason.

/** `${draftCount}` in the YAML. Resolved against the host's chosen parameters (D25). */
export type NumberOrParam = number | { param: string }

export interface SimultaneousCommitSpec {
  type: 'SIMULTANEOUS_COMMIT'
  id: string
  commits: {
    picks: { count: NumberOrParam; pool: PoolName } | null
    metaBan: { count: 1; pool: PoolName; tier: 'META'; targets: 'OPPONENT_ONLY' } | null
  }
  /** Which committed slices open, and when. DEFERRED leaves it to a downstream REVEAL. */
  reveal: { picks: RevealTiming; metaBan: RevealTiming }
}

export type RevealTiming = 'IMMEDIATE' | 'DEFERRED' | 'NONE'

export interface ConditionalRecommitSpec {
  type: 'CONDITIONAL_RECOMMIT'
  id: string
  trigger: 'repickTrigger'
  pool: PoolName
  hidden: boolean
}

export interface RevealSpec {
  type: 'REVEAL'
  id: string
  slices: SliceName[]
}

export interface RollSpec {
  type: 'ROLL'
  id: string
  dice: DiceSpec
  actors: 'BOTH'
  resolve: 'HIGHEST'
  onTie: 'REROLL'
  /** D11 — non-null in round 2, where the roll assigns turn order and no CHOOSE exists. */
  assigns: 'TURN_ORDER' | null
}

export interface ChooseSpec {
  type: 'CHOOSE'
  id: string
  actor: ActorRef
  options: ChoiceOption[]
  /** D2 — the roll winner takes one privilege, the loser receives the complement. */
  loserGets: 'COMPLEMENT' | null
}

/** D10 — the round-1 inversion. No decision, but a recorded transition. */
export interface AssignSpec {
  type: 'ASSIGN'
  id: string
  privilegeHolder: 'INVERT_PREVIOUS'
  turnOrderHolder: 'INVERT_PREVIOUS'
}

export interface BanSpec {
  type: 'BAN'
  id: string
  tier: 'ROUND'
  actor: ActorRef
  pool: PoolName
}

export interface SelectSpec {
  type: 'SELECT'
  id: string
  /** D26 applies to both modes: a decision with one option is not a decision. */
  mode: 'SEQUENTIAL' | 'SIMULTANEOUS_HIDDEN'
  actor: ActorRef
  pool: PoolName
}

export interface ReportResultSpec {
  type: 'REPORT_RESULT'
  id: string
  allowTie: boolean
}

export type RoundModuleSpec =
  RollSpec | ChooseSpec | AssignSpec | BanSpec | SelectSpec | ReportResultSpec

export interface RoundLoopSpec {
  type: 'ROUND_LOOP'
  id: string
  count: number
  template: RoundModuleSpec[]
  overrides: Partial<Record<RoundIdx, RoundOverride>>
}

/**
 * Applied at resolution time, not at run time. `remove` deletes a decision module; it may
 * never delete a state transition (spec §13, transition preservation).
 */
export interface RoundOverride {
  /** Module ids, never types — see the note above. */
  remove?: string[]
  /** D10 — insert an ASSIGN in place of the removed roll and choice. */
  insert?: AssignSpec[]
  /** D22/§9.3 — R1 hands the *opponent* the last-pick information advantage. */
  selectOrder?: [ActorRef, ActorRef]
  /** D11 — the roll assigns turn order directly. */
  rollAssigns?: 'TURN_ORDER'
  /** D22 — R2 replaces the two sequential selects with one simultaneous hidden one. */
  select?: { mode: 'SIMULTANEOUS_HIDDEN'; actor: 'BOTH'; pool: PoolName }
  /**
   * D30 — overtime forbids the tie it exists to break.
   *
   * Without this the tiebreaker can end 2.0–2.0 with no characters left, which is the exact
   * deadlock G14's termination check was written to keep out of the loader.
   */
  report?: { allowTie: boolean }
}

export type ModuleSpec =
  SimultaneousCommitSpec | ConditionalRecommitSpec | RevealSpec | RoundLoopSpec | RoundModuleSpec

// --- Mode definition ------------------------------------------------------------------------

export interface ParameterSpec {
  values: readonly (string | number)[]
  default: string | number
  label: string
}

export interface ModeDefinition {
  modeId: string
  /** May interpolate `${param}` — resolved before it reaches a player (§12.3). */
  label: string
  parameters: Record<string, ParameterSpec>
  modules: ModuleSpec[]
  onTie: TieRule
  match: MatchRule
  overtime: OvertimeRule
}

// --- Resolved program -----------------------------------------------------------------------

/** Every resolved module carries its place in the flattened program. */
interface ResolvedCommon {
  /** Unique within the program, e.g. `rounds.1.ban`. */
  id: string
  /** `null` for the modules that run before the round loop. */
  roundIndex: RoundIdx | null
}

/**
 * `count` is a number here — parameters are gone by resolution time — and `revealTags` records
 * *which event* opens each committed slice, so `Slice.revealedBy` can be set at commit time
 * rather than guessed at reveal time.
 */
export interface ResolvedSimultaneousCommit extends ResolvedCommon {
  type: 'SIMULTANEOUS_COMMIT'
  commits: {
    picks: { count: number; pool: PoolName } | null
    metaBan: { count: 1; pool: PoolName; tier: 'META'; targets: 'OPPONENT_ONLY' } | null
  }
  reveal: { picks: RevealTiming; metaBan: RevealTiming }
  /** `null` where the slice is never revealed by this module's own gate. */
  revealTags: { picks: EventTag | null; metaBan: EventTag | null }
}

export interface ResolvedConditionalRecommit extends ResolvedCommon, ConditionalRecommitSpec {
  revealTag: EventTag | null
}

/**
 * The flattened result of applying parameters and expanding `ROUND_LOOP` with its overrides.
 *
 * This is the load-bearing shape of the engine. Flattening the loop at resolution time makes
 * `reduce` a cursor over an array rather than an interpreter with a nested loop; makes
 * `remove` a filter rather than a run-time branch; and makes `stopWhenDecided` an early
 * terminal rather than loop control. It is snapshotted into MATCH_CREATED so a log replays
 * with no mode registry at all — which is exactly what Phase 5's export/replay gate needs.
 */
export type ResolvedModule =
  | ResolvedSimultaneousCommit
  | ResolvedConditionalRecommit
  | (RevealSpec & ResolvedCommon)
  | (RollSpec & ResolvedCommon)
  | (ChooseSpec & ResolvedCommon)
  | (AssignSpec & ResolvedCommon)
  | (BanSpec & ResolvedCommon)
  | (SelectSpec & ResolvedCommon)
  | (ReportResultSpec & ResolvedCommon)

export interface ResolvedMode {
  modeId: string
  /** Fully interpolated — no `${...}` survives resolution. */
  label: string
  parameters: Record<string, string | number>
  program: ResolvedModule[]
  onTie: TieRule
  match: MatchRule
  overtime: OvertimeRule
}
