/// <reference types="@cloudflare/workers-types" />

import { project } from '@banpick/engine'
import type { MatchState, RejectionCode, Seat, ServerMessage } from '@banpick/types'

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
