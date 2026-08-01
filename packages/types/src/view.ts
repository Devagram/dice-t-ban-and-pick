import type { Seat } from './seat.js'
import type { Character, CharId } from './character.js'
import type { RoundIdx, Slot, SlotIdx } from './slot.js'
import type { Ruleset } from './ruleset.js'
import type { MatchOutcome, RoundOutcome } from './event.js'
import type { MatchStatus } from './state.js'
import type { Action } from './action.js'
import type { ModuleType } from './mode.js'

/**
 * Spec §7 — **the security boundary.**
 *
 * "The client must never receive a redacted value with a flag; it must receive nothing."
 *
 * So every field a seat may not see is *optional and absent*, never `null` and never
 * `{ redacted: true }`. With `exactOptionalPropertyTypes` on, that makes a leak a type error
 * at the point of construction rather than something a reviewer has to notice — and the
 * required §7 test asserts on the serialized string, because an object test passes while a
 * `toJSON` leaks.
 */
export interface SeatView {
  seat: Seat
  score: number
  /** Absent while sealed. */
  slots?: Slot[]
  /** Absent while sealed. */
  metaBanPlaced?: CharId | null
  /**
   * D28 — what this seat may not ban, from the previous set. Present on **your own** seat only;
   * the opponent's would leak what they banned last time.
   */
  deniedMetaBans?: CharId[]
  /**
   * That a commitment *exists* is public — the UI has to render "waiting for opponent".
   * What it contains is not. Sealing the fact as well would make the wait unexplainable.
   */
  hasCommitted: boolean
  /** How many slots this seat holds. Public: it is `draftCount`, which is on the ruleset. */
  slotCount: number
}

/**
 * D28 — what you may not ban this match, because you brought it against this same opponent last
 * set.
 *
 * **Yours only.** It is your own history, so telling you costs nothing — and without it the
 * character simply vanishes from your pool with no explanation, which reads as a bug. The
 * opponent's denial is not here: it would say what *they* banned last time, which they know and
 * you should not.
 */
export interface RoundView {
  index: RoundIdx
  privilegeHolder: Seat | null
  turnOrderHolder: Seat | null
  /**
   * Every throw, so the client can play the reroll out rather than summarising it.
   *
   * Public in full: the roll is server-authored and already decided by the time any seat sees
   * it, so there is nothing here to hide from anyone. The animation is a *reveal*, not a roll.
   */
  roll: {
    results: Record<Seat, number>
    winner: Seat
    attempts: number
    throws: Record<Seat, number>[]
  } | null
  ban: { by: Seat; target: { seat: Seat; slotIndex: SlotIdx } } | null
  /** Keys absent while a selection is sealed (round 2's simultaneous hidden pick). */
  selection: Partial<Record<Seat, SlotIdx | null>>
  selectionCommitted: Record<Seat, boolean>
  playOrder: { declaredBy: Seat; first: Seat } | null
  result: RoundOutcome | null
}

export interface PhaseView {
  moduleId: string
  type: ModuleType
  roundIndex: RoundIdx | null
  /** Which seats this module is waiting on. Drives every "your turn" affordance. */
  awaiting: Seat[]
}

/**
 * The entire wire contract to a client. Note what is **not** here: `mode.program`. The client
 * renders actions the server computed; it has no use for the module list, and not shipping it
 * is the same instinct as D18.
 */
export interface PlayerView {
  status: MatchStatus
  seat: Seat
  engineVersion: string
  ruleset: Ruleset
  mode: { modeId: string; label: string; parameters: Record<string, string | number> }
  /** Display data only. Retired characters are included so old logs still render (D14). */
  roster: Character[]
  you: SeatView
  opponent: SeatView
  rounds: RoundView[]
  phase: PhaseView | null
  legalActions: Action[]
  outcome: MatchOutcome | null
  /** Log length at projection time. Lets a reconnecting client detect a stale frame (D17). */
  seq: number
}
