/// <reference types="@cloudflare/workers-types" />

import { project } from '@banpick/engine'
import type { MatchState, RejectionCode, RoundOutcome, Seat, ServerMessage } from '@banpick/types'

/**
 * **The single outbound choke point.**
 *
 * The delivery plan is unusually blunt about this: *"Every frame leaving the DO passes through
 * one function that calls `project()`. Not two functions. One. Grep for the WebSocket send API
 * in CI and fail the build if it appears anywhere else."*
 *
 * That is because §7's redaction is a property of `project()`, and a property enforced in two
 * places is a property that will eventually hold in one of them. `scripts/check-outbound.mjs`
 * fails the build if `.send(` appears anywhere in `apps/worker/src` except this file.
 *
 * The rule it enforces: **a `MatchState` never leaves this module.** Everything on the wire is
 * a `PlayerView` for a named seat, built here, serialized here.
 */

/** A socket with the seat it is authenticated as. Attached at accept time. */
export interface SeatSocket {
  socket: WebSocket
  seat: Seat
}

/**
 * Sends a seat its own projection of the current state.
 *
 * `project` is called **per socket**, not once per state, because two seats must never receive
 * the same frame — that is the whole content of the redaction guarantee.
 */
export function sendView(target: SeatSocket, state: MatchState): void {
  deliver(target.socket, { type: 'VIEW', view: project(state, target.seat) })
}

/** Fans out to every connected socket, each getting its own seat's view. */
export function broadcastView(targets: Iterable<SeatSocket>, state: MatchState): void {
  for (const target of targets) sendView(target, state)
}

/** A rejected action. Carries no state — the client re-reads its last VIEW. */
export function sendRejection(
  target: SeatSocket,
  idempotencyKey: string,
  code: RejectionCode,
  detail: string,
): void {
  deliver(target.socket, { type: 'REJECTED', idempotencyKey, code, detail })
}

/**
 * Relays one seat's self-reported progress to the other.
 *
 * It lives in this file for the same reason everything else does: this is the only module that
 * may touch the socket, and the rule is worth more than the exception would save. It carries a
 * **count and nothing else** — never a character id — because during a hidden commit that is
 * exactly what the seal is protecting (§7). The count is not projected because it is not state;
 * it never entered the log and never will.
 *
 * `seat` comes from the sender's authenticated socket, not from the message body, so a client
 * cannot report progress on its opponent's behalf.
 */
export function relayProgress(
  targets: Iterable<SeatSocket>,
  from: Seat,
  filled: number,
  of: number,
  ban: boolean,
): void {
  for (const target of targets) {
    if (target.seat === from) continue // you already know your own progress
    deliver(target.socket, { type: 'OPPONENT_PROGRESS', seat: from, filled, of, ban })
  }
}

/**
 * D32 — announces the rematch room to both seats, each with its own seat in it.
 *
 * Sent to everyone including the seat that asked, so a player with the match open in two places
 * sees it in both. The room code and the opening seat are public between these two and go out
 * unfiltered; **the seat token does not**. It is a bearer credential for a seat in the next room
 * (D17), so it is looked up per socket by the seat that socket authenticated as — the same
 * per-target discipline `sendView` applies to state, applied to the one credential that now
 * travels on this wire.
 *
 * `seats` may be missing a seat, or be empty. A socket that has no token for its own seat gets
 * the frame it always got, and its client falls back to the ordinary join page.
 */
export function announceRematch(
  targets: Iterable<SeatSocket>,
  roomCode: string,
  by: Seat,
  seats: Partial<Record<Seat, string>> = {},
): void {
  for (const target of targets) {
    const seatToken = seats[target.seat]
    deliver(
      target.socket,
      seatToken ? { type: 'REMATCH', roomCode, by, seatToken } : { type: 'REMATCH', roomCode, by },
    )
  }
}

/**
 * D33 — announces a corrected round to both seats.
 *
 * Sent to the amender too, so a player with the match open twice sees it in both places. Round
 * index and outcome are public from the moment a result is reported, so like the rematch frame
 * this carries nothing `project()` would have redacted — which is why it can go out unfiltered.
 */
export function announceAmendment(
  targets: Iterable<SeatSocket>,
  roundIndex: number,
  outcome: RoundOutcome,
  by: Seat,
): void {
  for (const target of targets) {
    deliver(target.socket, { type: 'RESULT_AMENDED', roundIndex, outcome, by })
  }
}

// --- D37: the tournament socket -----------------------------------------------------------------

/**
 * **The bracket, to everyone watching.**
 *
 * Routed through this module because the rule is that *nothing* in the worker touches the socket
 * API except here, and an exception for "but this one is public" is exactly how a choke point
 * stops being one. `scripts/check-outbound.mjs` would fail the build either way.
 *
 * There is no `project()` call and there must not be one: a `TournamentView` is not a projection
 * of match state, it is entrant names, scores and advancement — every field of which is public
 * for the same reason D31's lobby list and D34's history are. What matters is the **negative**
 * guarantee, and it is structural rather than filtered: this function's argument type cannot
 * express anything from inside a live match, so there is no in-progress draft, no sealed ban and
 * no hidden selection available to leak. The redaction test asserts it against the real frame
 * anyway, because a type is a promise and a wire capture is a property.
 */
export function broadcastBracket(sockets: Iterable<WebSocket>, view: unknown): void {
  for (const socket of sockets) deliver(socket, { type: 'BRACKET', view } as ServerMessage)
}

/** A protocol-level problem. Also carries no state. */
export function sendProtocolError(
  socket: WebSocket,
  code: Extract<ServerMessage, { type: 'ERROR' }>['code'],
  detail: string,
): void {
  deliver(socket, { type: 'ERROR', code, detail })
}

/**
 * The only place in the worker that touches the WebSocket send API.
 *
 * Serialization happens here too, so the §7 assertion can run against the *real frame off the
 * wire* rather than an object that a `toJSON` might yet betray.
 */
function deliver(socket: WebSocket, message: ServerMessage): void {
  try {
    socket.send(JSON.stringify(message))
  } catch {
    // A socket that closed between the state change and the fan-out is a normal event, not an
    // error: D17 makes disconnects non-events, and the client resyncs in full on reconnect.
  }
}
