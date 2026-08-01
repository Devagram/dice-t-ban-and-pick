import type { Actor, Seat } from './seat.js'
import type { CharId, Roster } from './character.js'
import type { RoundIdx, SlotIdx } from './slot.js'
import type { Ruleset } from './ruleset.js'
import type { SliceName } from './slice.js'
import type { ResolvedMode } from './mode.js'

/**
 * A stable name referenced by `Slice.revealedBy` (spec §5). A slice opens when an event
 * carrying its tag has been appended — which is why reveal is data rather than a phase flag.
 */
export type EventTag = string

/**
 * Spec §5, D16.
 *
 * `seq` is the append index **and the RNG counter key** — that pairing is what lets Phase 5
 * evaluate any single roll without replaying its predecessors.
 */
export interface EventEnvelope {
  /** Event schema version (D16). Always 1 today; present from the first commit on purpose. */
  v: 1
  seq: number
  tag: EventTag
  actor: Actor
  payload: EventPayload
}

export type ChoiceOption = 'DRAFT_PRIVILEGE' | 'TURN_ORDER' | 'SELF_FIRST' | 'OPPONENT_FIRST'

/** Who won the round as reported by a human (D15). The app never validates this (§17). */
export type RoundOutcome = 'A' | 'B' | 'TIE'

export type MatchOutcome = 'A' | 'B' | 'DRAW'

export interface RoundBanTarget {
  /** Always the opponent's seat — a round ban targets an opponent slot (D3). */
  seat: Seat
  slotIndex: SlotIdx
}

export type EventPayload =
  /**
   * Spec §11 non-negotiables 1–3. The seed, the resolved ruleset, the roster, **and the
   * engine version** are all snapshotted here. Config without interpreter is half a snapshot.
   *
   * `mode` carries the fully resolved program too, so a log replays without a mode registry —
   * the thing Phase 5's export/replay gate actually needs. `modeContentHash` on the ruleset
   * still guards that this program is the one the named mode file produced.
   */
  | {
      type: 'MATCH_CREATED'
      seed: string
      ruleset: Ruleset
      roster: Roster
      mode: ResolvedMode
      engineVersion: string
    }
  /**
   * Locks the ruleset and (in the DO) mints the seat token (D17).
   *
   * `player` is self-asserted and deliberately so — §1's trust model is friendly opponents. The
   * `id` is generated per browser and is what cross-match history keys on, so a wrong `name`
   * costs a wrong label rather than a bypassed rule. Absent on a log written before D28.
   */
  | { type: 'SEAT_FILLED'; seat: Seat; player?: { id: string; name: string } }
  /**
   * D28 — what each seat may **not** ban this match, because they banned it against this same
   * opponent last time.
   *
   * Authored by SYSTEM the moment the second seat fills, which is the first point at which the
   * pairing is known — the host opens a room before anyone sits, so this cannot ride on
   * `MATCH_CREATED` with the roster and the ruleset.
   *
   * It is *in the log* rather than looked up, and that is the whole design: the engine stays a
   * pure function of its events (§5), and a replay reproduces the match without reaching for a
   * database that may since have moved on.
   */
  | { type: 'PAIRING_RESOLVED'; deniedMetaBans: Record<Seat, CharId[]> }
  /** SIMULTANEOUS_COMMIT. Hidden until the module's reveal tag lands. */
  | {
      type: 'COMMIT'
      moduleId: string
      seat: Seat
      picks: CharId[]
      /** `null` when the module declares no meta ban commit. */
      metaBan: CharId | null
    }
  /** CONDITIONAL_RECOMMIT — replaces only the slots the trigger predicate matched. */
  | {
      type: 'RECOMMIT'
      moduleId: string
      seat: Seat
      replacements: { index: SlotIdx; characterId: CharId }[]
    }
  /** Unseals named slices. Its `tag` is what `Slice.revealedBy` points at. */
  | { type: 'REVEAL'; moduleId: string; slices: SliceName[] }
  /**
   * Server-side dice (§11 — the DO is the authority for all dice). `results` is derived from
   * `(seed, seq, actor, attempt)`, so it replays exactly; `attempts` records how many rerolls
   * `onTie: REROLL` needed.
   */
  | {
      type: 'ROLL'
      moduleId: string
      roundIndex: RoundIdx
      results: Record<Seat, number>
      attempts: number
      /**
       * Every throw, in order, including the ties that forced a reroll. The last entry always
       * equals `results`.
       *
       * Recorded because a tie is the most interesting thing that can happen here — at 1d6 it
       * is about one roll in six — and without it the client can only say "after 2 attempts"
       * rather than showing the tie that caused it. That is a real moment to lose.
       *
       * It is also strictly more honest as a log: `onTie: REROLL` is a rule with observable
       * consequences, and an event that records only the outcome hides how it was reached.
       */
      throws: Record<Seat, number>[]
      winner: Seat
      /** D11 — in round 2 the roll assigns TURN_ORDER directly, with no CHOOSE. */
      assigns: 'TURN_ORDER' | null
    }
  | {
      type: 'CHOOSE'
      moduleId: string
      roundIndex: RoundIdx
      seat: Seat
      option: ChoiceOption
    }
  /**
   * D10 — round 1 inverts both privileges with no roll and no choice.
   *
   * Nothing is *decided* here, so D13 would permit deriving it silently. It is recorded
   * anyway because §15's headline metric is win rate by privilege role: an analysis script
   * that has to re-derive who held privilege from an absent event is one refactor away from
   * being quietly wrong.
   */
  | {
      type: 'ASSIGN'
      moduleId: string
      roundIndex: RoundIdx
      privilegeHolder: Seat | null
      turnOrderHolder: Seat | null
      reason: 'INVERTED'
    }
  | {
      type: 'BAN'
      moduleId: string
      roundIndex: RoundIdx
      seat: Seat
      tier: 'ROUND'
      target: RoundBanTarget
    }
  /**
   * D26 — `reason: 'FORCED'` marks an auto-commit, where exactly one legal option existed.
   * The actor is SYSTEM in that case. The event is still appended, still authored, still
   * replayable: `remove` may delete a decision, never a state transition (D13).
   */
  | {
      type: 'SELECT'
      moduleId: string
      roundIndex: RoundIdx
      seat: Seat
      slotIndex: SlotIdx
      reason: 'FORCED' | null
    }
  /** D15 — either seat reports, no confirmation. `reportedBy` is for log attribution. */
  | {
      type: 'REPORT_RESULT'
      moduleId: string
      roundIndex: RoundIdx
      reportedBy: Seat
      outcome: RoundOutcome
    }
  /**
   * A seat is ready to roll. Carries no number: the dice are the server's (§11 non-negotiable 1),
   * and this only records that a player asked for them.
   */
  | { type: 'ROLL_READY'; moduleId: string; roundIndex: RoundIdx; seat: Seat }
  /** D15 — open to either seat until the next round's roll. Covers the fat finger, not the lie. */
  | { type: 'UNDO_LAST_RESULT'; roundIndex: RoundIdx; requestedBy: Seat }
  /** Terminal. Emitted by SYSTEM when the match rule says there is nothing left to play. */
  | { type: 'MATCH_COMPLETE'; outcome: MatchOutcome }

export type EventType = EventPayload['type']

/** Narrowing helper — `payload.type === t` with the arm carried through. */
export type PayloadOf<T extends EventType> = Extract<EventPayload, { type: T }>
