import type { EventPayload } from './event.js'
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
    type: 'COMMIT' | 'RECOMMIT' | 'CHOOSE' | 'BAN' | 'SELECT' | 'REPORT_RESULT' | 'UNDO_LAST_RESULT'
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

export type ProtocolErrorCode =
  'MALFORMED' | 'RATE_LIMITED' | 'UNKNOWN_MESSAGE' | 'NOT_YOUR_SEAT' | 'UNAUTHENTICATED'

// --- HTTP surface ------------------------------------------------------------------------------

export interface CreateMatchRequest {
  modeId: string
  parameters: Record<string, string | number>
  /** Host-set, public, applies before everything (D5). */
  globalBanned: string[]
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
