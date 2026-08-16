/**
 * **D37 — the bracket, as data.**
 *
 * This package knows nothing about matches, dice, rulesets, or Durable Objects. It deals in
 * entrants and results, and that boundary is the point: a bracket is a **fold over a result log**,
 * so an advancement anyone disputes can be recomputed rather than argued about. `TournamentDO`
 * wraps it with storage and sockets and holds no bracket logic of its own.
 *
 * The same four properties `@banpick/engine` bought, for the same reasons — replay, Node-speed
 * exhaustive tests, a CI-enforced boundary, and no ambient nondeterminism (D42's plan §Phase 1).
 */

export type BracketFormat = 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION'

/** Which half of a double-elimination bracket a slot belongs to. */
export type BracketSide = 'WINNERS' | 'LOSERS' | 'GRAND_FINAL'

export type SeedingMode = 'AS_ENTERED' | 'RANDOM' | 'MANUAL'

export type EntrantId = string

/**
 * Human-readable and derived from the bracket's shape rather than allocated: `W1M2`, `L3M1`,
 * `GF`, `GF2`.
 *
 * A generated id would make a log unreadable and a bug report unwriteable — "the winner of W2M1
 * went to the wrong place" is a sentence someone can check, and `slot_7f3a91` is not.
 */
export type SlotId = string

export interface Entrant {
  entrantId: EntrantId
  /** D19/D35 — per-browser, and therefore not a stable identity. D41's token is the credential. */
  playerId: string
  displayName: string
  /** 1-based, lower is stronger. Assigned by `buildBracket` per the chosen `SeedingMode`. */
  seed: number
}

/**
 * Where a competitor in a slot comes from.
 *
 * Structural, not resolved: a bracket is built once and then *read* against a result log, so a
 * slot names its sources forever rather than being mutated as results arrive. That is what makes
 * `advance` a fold instead of a state machine.
 */
export type Ref =
  | { from: 'ENTRANT'; entrantId: EntrantId }
  /** A structural bye. Never a phantom opponent — the other side walks over. */
  | { from: 'BYE' }
  | { from: 'WINNER_OF'; slotId: SlotId }
  | { from: 'LOSER_OF'; slotId: SlotId }

export interface Slot {
  id: SlotId
  side: BracketSide
  /** 1-based, within its side. */
  round: number
  /** 1-based, within its round. */
  match: number
  entrants: [Ref, Ref]
  /** Where the winner goes. `null` only for the slot that decides the tournament. */
  winnerTo: SlotId | null
  /** Where the loser goes. `null` in single elimination, and at every elimination point. */
  loserTo: SlotId | null
}

/**
 * One entry in the result log. **Append-only**, and the last entry for a slot is the live one.
 *
 * D39's correction path relies on that: an organizer correcting a consumed result appends rather
 * than edits, so the bracket before and after a correction are both derivable from one log, and
 * "what did we think at the time" stays answerable.
 */
export type ResultEntry =
  | { slotId: SlotId; type: 'WIN'; winner: EntrantId }
  /** D38 — the two seats disagreed. Resolves nobody and routes nobody, by design. */
  | { slotId: SlotId; type: 'DISPUTE' }
  /** D39 — the organizer voided it. Also resolves nobody; distinguished so the UI can say which. */
  | { slotId: SlotId; type: 'VOID' }
  /**
   * The match was played and ended level.
   *
   * **A case the plan did not anticipate, and it is not hypothetical.** D21 makes 1.5–1.5 a legal
   * terminal state whenever nothing is left to play, and D36's Bo1 allows a tied single round
   * outright — so any tournament using either mode can produce a match with no winner. A bracket
   * cannot advance on that.
   *
   * Recorded as its own type rather than folded into `DISPUTE` or `VOID`, because it is neither:
   * nobody disagreed and nothing was cancelled. Two people played and drew. It resolves nobody,
   * routes nobody, and waits for the organizer — who is the only one who can decide whether that
   * is a replay, a coin toss, or a walkover, and none of those is a decision an app should make.
   */
  | { slotId: SlotId; type: 'DRAWN' }

/**
 * What a slot is, right now, derived from the log.
 *
 * **`LIVE` is deliberately absent.** "A room exists and two people are in it" is a fact about a
 * match, not about a bracket, and this package cannot know it without importing the thing it is
 * defined to not know about. `TournamentDO` overlays it for the UI (plan Phase 5). Putting it in
 * this union would mean a value nothing here can ever return.
 */
export type SlotStatus =
  /** At least one side is still unknown. */
  | 'PENDING'
  /** Both sides known, no result yet. This is what the tournament provisions matches from. */
  | 'READY'
  | 'DONE'
  /** Resolved without being played — one or both sides were a bye. */
  | 'BYE'
  | 'DISPUTED'
  | 'VOIDED'
  /** Played, ended level, and waiting on the organizer. See `ResultEntry`'s `DRAWN`. */
  | 'DRAWN'

export interface BracketState {
  format: BracketFormat
  entrants: Entrant[]
  slots: Slot[]
  /** D40 — whether the losers-bracket entrant must win the grand final twice. */
  grandFinalReset: boolean
  /**
   * The slot that crowns the champion, barring D40's reset.
   *
   * Recorded at build time rather than searched for. Looking for "the slot nothing routes out of"
   * is how the first version picked the winners final in a double-elimination bracket and crowned
   * somebody while the losers bracket was still playing — an inference that can be wrong, replaced
   * by a statement that cannot.
   */
  finalSlotId: SlotId
  /** Fixes `RANDOM` seeding. Nothing else in this package is nondeterministic. */
  seedingSeed: string
  results: ResultEntry[]
}

export interface BuildOptions {
  seeding?: SeedingMode
  /** Required by `RANDOM`; ignored otherwise. */
  seedingSeed?: string
  /** D40. Ignored in single elimination, where there is no losers bracket to reset from. */
  grandFinalReset?: boolean
}

/** A slot with its derived occupancy and status — what a bracket graphic renders. */
export interface SlotView {
  slot: Slot
  status: SlotStatus
  /** `null` where the side is a bye or still unknown; `SlotView.status` says which. */
  entrants: [EntrantId | null, EntrantId | null]
  winner: EntrantId | null
}
