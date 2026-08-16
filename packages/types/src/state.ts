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
  /** `throws` carries every attempt including ties; the last always equals `results`. */
  roll: {
    results: Record<Seat, number>
    winner: Seat
    attempts: number
    throws: Record<Seat, number>[]
  } | null
  /**
   * D36 — keyed by the seat that *placed* the ban, holding the opponent slot it hit.
   *
   * It was one `{ by, target }` record, which could not represent a round where both seats ban.
   * The target seat is dropped rather than lost: D3 already requires a round ban to target an
   * opponent slot, and `ban.A` therefore names a slot on B's board by construction — a stored
   * `target.seat` was a second copy of a fact the key already carried, and the only thing a second
   * copy can do is disagree.
   *
   * Sliced for the same reason `selection` is: a simultaneous ban is sealed until both are in, and
   * one phase enum cannot say "public here, sealed there" about the same field.
   */
  ban: Record<Seat, Slice<SlotIdx | null>>
  /**
   * Sliced because round 2 selects simultaneously and hidden, while rounds 0–1 select
   * sequentially in public. This is the case that forces §7's per-slice visibility: one phase
   * enum cannot say "public here, sealed there" about the same field.
   */
  selection: Record<Seat, Slice<SlotIdx | null>>
  /**
   * D24 — declared after both selections are revealed, so it is a real decision.
   *
   * D36 — `declaredBy` is null when nobody decided and the dice did: the Bo1's higher roll simply
   * goes first. Recorded rather than left blank, because "who went first" is worth having in the
   * log either way, and naming the roll winner as the declarer would put a decision in the record
   * that nobody made.
   */
  playOrder: { declaredBy: Seat | null; first: Seat } | null
  /**
   * D38 — what each seat says happened.
   *
   * Under `ONE_SIDED` the first entry resolves the round immediately and the other stays null,
   * which is D15 unchanged. Under `BOTH_SEATS` the round resolves only when both are in **and
   * they agree**; two entries that disagree leave `result` null and the round disputed.
   *
   * A seat may change its claim while the round is unresolved. Two people who misreported and
   * then talked should be able to fix it between themselves — escalating every fat finger to an
   * organizer would make the confirmation step cost more than it saves.
   */
  reports: Record<Seat, RoundOutcome | null>
  /** Set once the round is agreed. Null while it is unreported, half-reported, or disputed. */
  result: RoundOutcome | null
}

/** D38 — both seats have claimed a result and the claims differ. Derived, never stored. */
export function isDisputed(round: RoundState): boolean {
  return (
    round.result === null &&
    round.reports.A !== null &&
    round.reports.B !== null &&
    round.reports.A !== round.reports.B
  )
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
  /**
   * D28 — what each seat is barred from banning, carried in from the previous set against this
   * opponent. Empty when the rule is off, when there is no history, or before the pairing
   * resolves.
   */
  deniedMetaBans: Record<Seat, CharId[]>

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
