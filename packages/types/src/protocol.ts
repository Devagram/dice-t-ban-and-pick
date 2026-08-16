import type { EventPayload, RoundOutcome } from './event.js'
import type { PlayerView } from './view.js'
import type { RejectionCode } from './state.js'
import type { Ruleset } from './ruleset.js'
import type { Character } from './character.js'
import type { Seat } from './seat.js'

/**
 * The wire contract between a client and the Durable Object.
 *
 * It lives in `@banpick/types` because the client needs it and must never import the engine
 * (D18). Note what a client can therefore *say*: an intent to act. Not an event — the DO
 * authors those, because `seq`, `tag`, and the actor are all things the authority decides.
 */

/** The event payloads a seat is allowed to propose. Everything else is SYSTEM-authored. */
export type PlayerActionPayload = Extract<
  EventPayload,
  {
    type:
      | 'COMMIT'
      | 'RECOMMIT'
      | 'CHOOSE'
      | 'BAN'
      | 'SELECT'
      | 'REPORT_RESULT'
      | 'ROLL_READY'
      | 'UNDO_LAST_RESULT'
      | 'AMEND_RESULT'
  }
>

export type ClientMessage =
  /**
   * `idempotencyKey` is required, not optional. A double-clicked commit must not append twice,
   * and the seal makes that unfixable afterwards: a committed action cannot be withdrawn (§12).
   */
  | { type: 'ACTION'; idempotencyKey: string; payload: PlayerActionPayload }
  /** Ask for a fresh frame. Reconnect does this automatically; this is for a client that drifts. */
  | { type: 'RESYNC' }
  /**
   * "I have filled `filled` of `of` slots so far." Relayed to the opponent so a hidden draft
   * shows progress instead of a blank wait.
   *
   * **A count and nothing else — never which characters.** During a `SIMULTANEOUS_COMMIT` the
   * picks are sealed (§7) and the whole point of the seal is that the opponent learns nothing
   * about their content. A progress ping that named a character would defeat the mode.
   *
   * The server genuinely does not know this otherwise: a draft is *one* `COMMIT` carrying all
   * picks at once, so until it arrives there is nothing on the server to report. That is why
   * the client has to say so.
   *
   * It is **not** an event and never reaches the log. It is unverifiable — a client could lie
   * about its own progress — and that is acceptable precisely because it decides nothing. §1's
   * trust model grants friendly opponents, and the worst a liar achieves is a wrong progress
   * bar.
   */
  | {
      type: 'PROGRESS'
      /** Draft **slots** filled so far — not decisions. The rail renders one box per slot. */
      filled: number
      /** How many slots there are, which is `draftCount` and already public on the ruleset. */
      of: number
      /**
       * Whether a meta ban has been chosen, where the mode asks for one.
       *
       * Separate from the counts rather than folded into them: a `bring-ban1` commit is four
       * picks *and* a ban, and "3 of 5" cannot say whether that is three picks or two picks and
       * a ban — which makes it useless for drawing four slot boxes. A boolean beside the counts
       * keeps both readouts honest, and still names nothing.
       */
      ban?: boolean
    }

export type ServerMessage =
  /**
   * The only message that carries state, and the only one the outbound choke point emits.
   * Always a full `project()` — no deltas, so a reconnect is not a special case (D17).
   */
  | { type: 'VIEW'; view: PlayerView }
  /** An action the engine refused. Carries the key so a client can match it to what it sent. */
  | { type: 'REJECTED'; idempotencyKey: string; code: RejectionCode; detail: string }
  /** A protocol-level problem: malformed frame, rate limit, unknown message. */
  | { type: 'ERROR'; code: ProtocolErrorCode; detail: string }
  /**
   * The opponent's self-reported progress through a hidden commit. Cosmetic, ephemeral, and
   * carries a count only — see the `PROGRESS` client message for why it exists and why it is
   * safe.
   *
   * `seat` is whose progress this is, decided by the server from the sender's token rather than
   * taken from the message.
   */
  | { type: 'OPPONENT_PROGRESS'; seat: Seat; filled: number; of: number; ban: boolean }
  /**
   * D32 — the other seat opened a rematch, and here is where it is.
   *
   * Pushed rather than polled because the completed match is the only channel these two players
   * still share: without it, "play again" is back to copying a link, which is the thing it exists
   * to remove. Carries the code and the seat that asked, and nothing else — the receiving client
   * still joins through the ordinary lobby, so §12.3's consent-before-seating is untouched.
   */
  | { type: 'REMATCH'; roomCode: string; by: Seat }
  /**
   * **D37 — the whole bracket, to everyone watching it.**
   *
   * Sent in full on connect and again on every change, with no deltas — the same choice D17 makes
   * for `VIEW` and for the same reason: a reconnect stops being a special case, and there is no
   * client-side merge that can drift from the server.
   *
   * `view` is a `TournamentView` (entrants, slot statuses, advancement, room codes). It is
   * deliberately **not** typed as such here: `@banpick/types` is the wire contract shared with the
   * client, and the tournament's shape lives in the worker beside the object that owns it. What
   * the client needs from this package is that a frame of this type exists and carries a payload;
   * what it may safely contain is a property of the sender, asserted on the real frame by the
   * redaction test rather than promised by a type.
   */
  | { type: 'BRACKET'; view: unknown }
  /**
   * D33 — someone corrected an earlier round, and the other seat is told rather than left to
   * notice the score move.
   *
   * The new view carries the correction already; this exists so it does not arrive silently. It
   * names a round and an outcome, both of which are public the moment a result is reported, so
   * it carries nothing `project()` would have redacted.
   */
  | { type: 'RESULT_AMENDED'; roundIndex: number; outcome: RoundOutcome; by: Seat }

export type ProtocolErrorCode =
  'MALFORMED' | 'RATE_LIMITED' | 'UNKNOWN_MESSAGE' | 'NOT_YOUR_SEAT' | 'UNAUTHENTICATED'

// --- HTTP surface ------------------------------------------------------------------------------

export interface CreateMatchRequest {
  modeId: string
  parameters: Record<string, string | number>
  /** Host-set, public, applies before everything (D5). */
  globalBanned: string[]
  /**
   * D28 — may a player bring the same meta ban against the same person two sets running?
   *
   * Absent means no, which is the default the rule was asked for. Sent as a boolean rather than
   * the ruleset's enum because this is the host's *answer*, and `rulesetFor` is where an answer
   * becomes a rule.
   */
  allowRepeatBans?: boolean
}

export interface CreateMatchResponse {
  roomCode: string
  /** Carries the room code and nothing else — D20 cut the hash from the URL. */
  joinUrl: string
}

/**
 * What a joiner sees **before** taking a seat (§12.3).
 *
 * "Seating is the consent", so this has to be the fully rendered ruleset rather than a summary:
 * mode name, parameter values, global bans, and the tie rule. A host quietly switching from 4
 * picks to 3 is exactly the change being consented to.
 */
export interface LobbyPreview {
  roomCode: string
  modeLabel: string
  ruleset: Ruleset
  /** Resolved for display, so the client never has to look a ban up by id. */
  globalBannedCharacters: Character[]
  roster: Character[]
  seatsAvailable: Seat[]
  status: 'LOBBY' | 'IN_PROGRESS' | 'COMPLETE'
}

export interface ClaimSeatResponse {
  seat: Seat
  /**
   * D17 — the sole credential for this seat, returned **once**. Stored in `localStorage` for
   * refresh and embedded in `resumeUrl` for a device change.
   *
   * It is a bearer credential: whoever holds it holds the seat, including its hidden commits.
   * Acceptable under the casual-play trust model (D19), and worth a line of UI copy rather
   * than a silent assumption.
   */
  seatToken: string
  resumeUrl: string
  websocketUrl: string
}

export interface ApiError {
  error: string
  detail: string
}
