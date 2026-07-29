import type { Seat } from './seat.js'
import type { CharId, Roster } from './character.js'
import type { RoundIdx, Slot, SlotIdx } from './slot.js'
import type { Slice } from './slice.js'
import type { Ruleset } from './ruleset.js'
import type { ResolvedMode } from './mode.js'
import type { EventEnvelope, MatchOutcome, RoundOutcome } from './event.js'

export type MatchStatus = 'LOBBY' | 'IN_PROGRESS' | 'COMPLETE'

export interface SeatState {
  slots: Slice<Slot[]>
  metaBanPlaced: Slice<CharId | null>
  /**
   * HALF_POINT scoring (D21): 1 for a win, 0.5 for a tie. Halves are exactly representable
   * in binary floating point, so this stays safe for the canonical state comparison.
   */
  score: number
}

export interface RoundState {
  index: RoundIdx
  /** Assigned by CHOOSE in R0, ASSIGN in R1, and never in R2 — no draft privilege exists (D11). */
  privilegeHolder: Seat | null
  /** D23 — the right to *decide* play order, not automatic first play. */
  turnOrderHolder: Seat | null
  roll: { results: Record<Seat, number>; winner: Seat; attempts: number } | null
  ban: { by: Seat; target: { seat: Seat; slotIndex: SlotIdx } } | null
  /**
   * Sliced because round 2 selects simultaneously and hidden, while rounds 0–1 select
   * sequentially in public. This is the case that forces §7's per-slice visibility: one phase
   * enum cannot say "public here, sealed there" about the same field.
   */
  selection: Record<Seat, Slice<SlotIdx | null>>
  /** D24 — declared after both selections are revealed, so it is a real decision. */
  playOrder: { declaredBy: Seat; first: Seat } | null
  result: RoundOutcome | null
}

/** Spec §5. */
export interface MatchState {
  status: MatchStatus
  /** Snapshotted at creation, never dereferenced (§11 non-negotiable 2). */
  ruleset: Ruleset
  roster: Roster
  mode: ResolvedMode
  seed: string
  /** D16. A major mismatch refuses replay rather than producing a different answer quietly. */
  engineVersion: string

  seatsFilled: Record<Seat, boolean>
  seats: Record<Seat, SeatState>
  /** Derived from the opponent's meta ban at reveal. Denies, it does not prevent (§9.2). */
  metaBannedAgainst: Record<Seat, CharId[]>

  rounds: RoundState[]
  /**
   * Index into `mode.program`. The whole reason the round loop is flattened at resolution
   * time: the engine is a cursor, not an interpreter.
   */
  cursor: number
  outcome: MatchOutcome | null
  log: EventEnvelope[]
}

/**
 * `reduce` is total: an illegal event returns a rejection rather than throwing. Throwing
 * reducers and event sourcing are a bad marriage — a throw mid-fold leaves no record of what
 * was attempted.
 */
export type ReduceResult =
  { ok: true; state: MatchState } | { ok: false; code: RejectionCode; detail: string }

export type RejectionCode =
  | 'MATCH_NOT_CREATED'
  | 'ALREADY_CREATED'
  | 'ENGINE_VERSION_MISMATCH'
  | 'MATCH_COMPLETE'
  | 'SEAT_TAKEN'
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'WRONG_MODULE'
  | 'ILLEGAL_CHARACTER'
  | 'ILLEGAL_SLOT'
  | 'ILLEGAL_OPTION'
  | 'ILLEGAL_TARGET'
  | 'DUPLICATE_COMMIT'
  | 'WRONG_COMMIT_SHAPE'
  | 'NOTHING_TO_UNDO'
  | 'UNDO_WINDOW_CLOSED'
