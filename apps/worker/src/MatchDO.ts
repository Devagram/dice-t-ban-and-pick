/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'
import { ENGINE_VERSION, legalActions, reduce, systemStep } from '@banpick/engine'
import {
  activeRoster,
  SEATS,
  type ClaimSeatResponse,
  type ClientMessage,
  type CreateMatchRequest,
  type EventEnvelope,
  type LobbyPreview,
  type MatchState,
  type PlayerActionPayload,
  type RejectionCode,
  type Roster,
  type Seat,
} from '@banpick/types'

import rosterAsset from '../../../roster/roster.json' with { type: 'json' }
import { hashToken, mintSeatToken, resumeUrl } from './identity.js'
import { draftCountOf, findMode, findVariant, rulesetFor, type BundledVariant } from './modes.js'
import {
  tryAppendEvent,
  claimSeat,
  claimedSeats,
  eventCount,
  getMeta,
  loadEvents,
  migrate,
  recallAction,
  rememberAction,
  seatForTokenHash,
  setMeta,
} from './persistence.js'
import {
  broadcastView,
  sendProtocolError,
  sendRejection,
  sendView,
  type SeatSocket,
} from './outbound.js'
import { RateLimiter } from './rateLimit.js'

const ROSTER = rosterAsset as Roster

/** D17 — 7 days idle, then the DO evicts and the match archives to log-only. No forfeit. */
const IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

/** Retries on a lost append race. Under Durable Objects this is never reached even once. */
const MAX_APPEND_ATTEMPTS = 5

/**
 * **One Durable Object per match (D8).**
 *
 * §11: "Single-threaded execution means simultaneous ready-clicks cannot interleave, and the DO
 * is the authority for all dice and all legality." Everything in this class depends on that and
 * nothing in it may undermine it — in particular, no `await` sits between reading state and
 * appending the event derived from it.
 *
 * State is **not** cached across requests as a field. It is a fold over the event log, rebuilt
 * per invocation, because a cached projection is a second source of truth and the one that goes
 * stale is always the cached one. A full match is a few dozen events (§11's table), so the fold
 * is cheaper than the bug.
 */
export class MatchDO extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private readonly limiter = new RateLimiter()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.sql)
    })
  }

  // --- HTTP ------------------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const action = url.pathname.split('/').filter(Boolean).pop()

    switch (action) {
      case 'create':
        return this.handleCreate(request)
      case 'preview':
        return this.handlePreview()
      case 'seat':
        return this.handleClaimSeat(request, url)
      case 'ws':
        return this.handleWebSocket(request, url)
      default:
        return json({ error: 'NOT_FOUND', detail: `no route for ${url.pathname}` }, 404)
    }
  }

  /**
   * §12.1 — the host selects mode, parameters, and the global ban list; the system resolves a
   * `Ruleset` and snapshots everything into the creation event.
   */
  private async handleCreate(request: Request): Promise<Response> {
    if (this.created()) {
      return json({ error: 'ALREADY_CREATED', detail: 'this room code is in use' }, 409)
    }

    const body = (await request.json()) as CreateMatchRequest & { roomCode?: string }
    const mode = findMode(body.modeId)
    if (!mode) return json({ error: 'UNKNOWN_MODE', detail: `no mode '${body.modeId}'` }, 400)

    const variant = findVariant(mode, body.parameters)
    if (!variant) {
      // Every offerable combination was validated at build time (D25). A miss means the caller
      // is asking for something nobody checked, which is exactly what must not reach the engine.
      return json(
        { error: 'UNKNOWN_PARAMETERS', detail: 'no validated variant for those parameters' },
        400,
      )
    }

    const globalBanned = [...new Set(body.globalBanned ?? [])].sort()
    const viability = this.checkRosterViability(variant, globalBanned)
    if (viability) return json(viability, 400)

    const seed = crypto.randomUUID()
    const event: EventEnvelope = {
      v: 1,
      seq: 0,
      tag: 'match:created',
      actor: 'SYSTEM',
      payload: {
        type: 'MATCH_CREATED',
        seed,
        ruleset: rulesetFor(variant, ROSTER.rosterVersion, globalBanned),
        roster: ROSTER,
        mode: variant.mode,
        engineVersion: ENGINE_VERSION,
      },
    }

    const result = reduce(null, event)
    if (!result.ok) return json({ error: result.code, detail: result.detail }, 500)

    // A lost race here means another request created this room first — the room-code collision
    // the router already retries on, so it gets the same 409 as a duplicate create.
    if (!tryAppendEvent(this.sql, event)) {
      return json({ error: 'ALREADY_CREATED', detail: 'this room code is in use' }, 409)
    }
    setMeta(this.sql, 'roomCode', body.roomCode ?? '')
    this.touch()
    return json({ ok: true }, 201)
  }

  /**
   * **Phase 2 finding F4.** The loader validates that the roster alone can support the mode, but
   * `globalBanned` is empty at load time because the host has not chosen yet. A host can ban a
   * match into unplayability, and the only place that can be caught is here — before a joiner
   * consents to it by sitting down.
   */
  private checkRosterViability(
    variant: BundledVariant,
    globalBanned: string[],
  ): { error: string; detail: string } | null {
    const banned = new Set(globalBanned)
    const available = activeRoster(ROSTER).filter((id) => !banned.has(id)).length
    const floor = draftCountOf(variant) + 1

    if (available < floor) {
      return {
        error: 'ROSTER_VIABILITY',
        detail:
          `${available} characters remain after ${globalBanned.length} global bans, but drafting ` +
          `${draftCountOf(variant)} with a meta ban needs at least ${floor} (§13).`,
      }
    }
    return null
  }

  /**
   * §12.3 — the joiner sees the fully rendered ruleset **before** taking a seat, because seating
   * is the consent and consent to a summary is not consent.
   */
  private handlePreview(): Response {
    const state = this.rebuild()
    if (!state) return json({ error: 'NO_MATCH', detail: 'nothing has been created here' }, 404)

    const taken = new Set(claimedSeats(this.sql))
    const byId = new Map(ROSTER.characters.map((c) => [c.id, c]))

    const preview: LobbyPreview = {
      roomCode: getMeta(this.sql, 'roomCode') ?? '',
      modeLabel: state.mode.label,
      ruleset: state.ruleset,
      globalBannedCharacters: state.ruleset.globalBanned.flatMap((id) => {
        const character = byId.get(id)
        return character ? [character] : []
      }),
      roster: ROSTER.characters,
      seatsAvailable: SEATS.filter((s) => !taken.has(s)),
      status: state.status,
    }
    return json(preview)
  }

  /** §12.4 — `SEAT_FILLED` locks the ruleset and mints the seat token (D17). */
  private async handleClaimSeat(request: Request, url: URL): Promise<Response> {
    const state = this.rebuild()
    if (!state) return json({ error: 'NO_MATCH', detail: 'nothing has been created here' }, 404)

    const taken = new Set(claimedSeats(this.sql))
    const seat = SEATS.find((s) => !taken.has(s))
    if (!seat) return json({ error: 'MATCH_FULL', detail: 'both seats are taken' }, 409)

    const event: EventEnvelope = {
      v: 1,
      seq: state.log.length,
      tag: `seat:${seat}`,
      actor: seat,
      payload: { type: 'SEAT_FILLED', seat },
    }
    const result = reduce(state, event)
    if (!result.ok) return json({ error: result.code, detail: result.detail }, 409)

    const token = mintSeatToken()
    // The token is minted and hashed before the event lands, so a failure here cannot leave a
    // seat filled with no way to claim it.
    const tokenHash = await hashToken(token)

    // Two people opening the join link at the same instant both see a free seat. The append is
    // what actually decides it, so the loser is told the seat went rather than being handed a
    // token for a seat somebody else holds.
    if (!tryAppendEvent(this.sql, event)) {
      return json({ error: 'SEAT_TAKEN', detail: 'somebody just took that seat' }, 409)
    }
    claimSeat(this.sql, seat, tokenHash, Date.now())
    this.settleAndBroadcast(result.state)
    this.touch()

    const roomCode = getMeta(this.sql, 'roomCode') ?? ''
    const origin = new URL(request.url).origin || url.origin
    const response: ClaimSeatResponse = {
      seat,
      seatToken: token,
      resumeUrl: resumeUrl(origin, roomCode, token),
      websocketUrl: `${origin.replace(/^http/, 'ws')}/api/match/${roomCode}/ws`,
    }
    return json(response, 201)
  }

  // --- WebSocket -------------------------------------------------------------------------------

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'EXPECTED_UPGRADE', detail: 'this endpoint speaks WebSocket' }, 426)
    }

    const token = url.searchParams.get('token')
    const seat = token ? seatForTokenHash(this.sql, await hashToken(token)) : null
    if (!seat) {
      return json({ error: 'UNAUTHENTICATED', detail: 'a valid seat token is required' }, 401)
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    // Hibernation: the DO can be evicted between messages and the socket survives. Without it,
    // two players thinking about a draft bill duration continuously — the difference between
    // §11's headroom table holding and not.
    this.ctx.acceptWebSocket(server, [seat])

    const state = this.rebuild()
    // D17 — "Reconnect presents the token and receives a full `project()` resync. No deltas, no
    // replay-from-client." A reconnect is just another moment to answer what a seat may know.
    if (state) sendView({ socket: server, seat }, state)
    this.touch()

    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const seat = this.seatOf(socket)
    if (!seat) {
      sendProtocolError(socket, 'UNAUTHENTICATED', 'this socket has no seat')
      return
    }

    let message: ClientMessage
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      sendProtocolError(socket, 'MALFORMED', 'not JSON')
      return
    }

    const target: SeatSocket = { socket, seat }

    if (!this.limiter.allow(seat)) {
      sendProtocolError(socket, 'RATE_LIMITED', 'too many actions; slow down')
      return
    }

    const state = this.rebuild()
    if (!state) {
      sendProtocolError(socket, 'MALFORMED', 'this match does not exist')
      return
    }

    switch (message.type) {
      case 'RESYNC':
        sendView(target, state)
        return
      case 'ACTION':
        this.applyAction(target, state, message.idempotencyKey, message.payload)
        this.touch()
        return
      default:
        sendProtocolError(socket, 'UNKNOWN_MESSAGE', 'unrecognized message type')
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    // Nothing to clean up, and that is D17's point: a disconnect is a non-event. The seat is
    // held by the token, not by the socket, so there is no forfeit, no timer, and no state to
    // unwind.
    try {
      socket.close(1000, 'closed')
    } catch {
      // Already closed.
    }
  }

  // --- The action path -------------------------------------------------------------------------

  /**
   * Synchronous from the state read to the append, on purpose.
   *
   * §11's guarantee is that "simultaneous ready-clicks cannot interleave", and that rests on the
   * DO being single-threaded — which only helps if no `await` sits between reading the log and
   * writing to it. An `await` there would yield, and two seats clicking ready in the same
   * millisecond could both read a pre-commit state and both produce a reveal.
   */
  private applyAction(
    target: SeatSocket,
    state: MatchState,
    idempotencyKey: string,
    payload: PlayerActionPayload,
  ): void {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      sendProtocolError(target.socket, 'MALFORMED', 'an idempotency key is required')
      return
    }

    // A double-clicked commit must not append twice. Replaying the *recorded outcome* rather
    // than re-running the action is what makes a retry safe even after the state has moved on.
    const seen = recallAction(this.sql, idempotencyKey)
    if (seen) {
      if (seen.accepted) sendView(target, state)
      else
        sendRejection(
          target,
          idempotencyKey,
          (seen.code ?? 'WRONG_PHASE') as RejectionCode,
          seen.detail ?? '',
        )
      return
    }

    // The seat is whoever holds the token, never whoever the payload claims to be.
    if ('seat' in payload && payload.seat !== target.seat) {
      sendProtocolError(target.socket, 'NOT_YOUR_SEAT', 'that action names another seat')
      return
    }
    if (payload.type === 'UNDO_LAST_RESULT' && payload.requestedBy !== target.seat) {
      sendProtocolError(target.socket, 'NOT_YOUR_SEAT', 'that action names another seat')
      return
    }

    // Read, judge, append — and if another writer claimed this `seq` first, do all three again
    // against what is actually in the log now. See `tryAppendEvent` for why this exists when
    // §11 already promises it cannot happen.
    //
    // Re-judging rather than re-appending is the important part. If the opponent's commit landed
    // in between, this action might now be illegal, and the answer has to come from the engine
    // reading the real state — not from a retry that assumes the verdict still holds.
    let current = state
    for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
      const event: EventEnvelope = {
        v: 1,
        seq: current.log.length,
        tag: `${'moduleId' in payload ? payload.moduleId : payload.type}:${payload.type}`,
        actor: target.seat,
        payload,
      }

      const result = reduce(current, event)
      if (!result.ok) {
        rememberAction(this.sql, idempotencyKey, target.seat, {
          accepted: false,
          code: result.code,
          detail: result.detail,
        })
        sendRejection(target, idempotencyKey, result.code, result.detail)
        return
      }

      if (!tryAppendEvent(this.sql, event)) {
        const fresh = this.rebuild()
        if (!fresh) break
        current = fresh
        continue
      }

      rememberAction(this.sql, idempotencyKey, target.seat, {
        accepted: true,
        code: null,
        detail: null,
      })
      this.settleAndBroadcast(result.state)
      return
    }

    // Losing the race this many times in a row is not contention, it is a bug.
    sendProtocolError(
      target.socket,
      'MALFORMED',
      'could not append after repeated conflicts; try again',
    )
  }

  /**
   * Drains everything the system owes — rolls, reveals, D10's inversion, D26's forced selects,
   * and the terminal `MATCH_COMPLETE` — appending each, then fans out one frame per seat.
   *
   * This is the integration point `systemStep` was designed for: `reduce` stays single-event and
   * pure, and the cascade lives here where a log and a socket exist.
   */
  private settleAndBroadcast(state: MatchState): void {
    let current = state
    for (let guard = 0; guard < 256; guard++) {
      const event = systemStep(current)
      if (!event) break
      const result = reduce(current, event)
      if (!result.ok) {
        throw new Error(
          `the engine authored an event its own reducer rejected (${result.code}). ` +
            'That is an engine bug, not a player action.',
        )
      }
      if (!tryAppendEvent(this.sql, event)) {
        // Another writer got there first, which means it is also draining the same system
        // events — they are a pure function of the state, so it will produce these exact
        // events. Stop and re-read rather than fight over them.
        const fresh = this.rebuild()
        if (fresh) current = fresh
        break
      }
      current = result.state
    }
    broadcastView(this.sockets(), current)
  }

  // --- State -----------------------------------------------------------------------------------

  /** State is a fold over the log. See the note on the class for why it is not cached. */
  private rebuild(): MatchState | null {
    const events = loadEvents(this.sql)
    if (events.length === 0) return null

    let state: MatchState | null = null
    for (const event of events) {
      const result = reduce(state, event)
      if (!result.ok) {
        // The log is the record of truth (D9). If it no longer folds, the interpreter changed
        // under it — which is exactly what D16's version refusal exists to make loud.
        throw new Error(`stored log does not replay: ${result.code} — ${result.detail}`)
      }
      state = result.state
    }
    return state
  }

  private created(): boolean {
    return eventCount(this.sql) > 0
  }

  private sockets(): SeatSocket[] {
    return this.ctx.getWebSockets().flatMap((socket) => {
      const seat = this.seatOf(socket)
      return seat ? [{ socket, seat }] : []
    })
  }

  /** The seat is carried in the hibernation tag, so it survives eviction. */
  private seatOf(socket: WebSocket): Seat | null {
    const tag = this.ctx.getTags(socket)[0]
    return tag === 'A' || tag === 'B' ? tag : null
  }

  /** D17 — 7 days idle, then evict. A match left alone expires; nobody forfeits. */
  private touch(): void {
    void this.ctx.storage.setAlarm(Date.now() + IDLE_EXPIRY_MS)
  }

  override async alarm(): Promise<void> {
    // "The DO evicts and the match archives to log-only." The events stay; the sockets and the
    // seat credentials do not.
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1001, 'match expired')
      } catch {
        // Already gone.
      }
    }
    this.sql.exec('DELETE FROM seats')
  }

  // --- Legality, exposed for tests ---------------------------------------------------------------

  /** What a seat may do right now. The client renders this and nothing else (§11.4). */
  legalFor(seat: Seat): ReturnType<typeof legalActions> {
    const state = this.rebuild()
    return state ? legalActions(state, seat) : []
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
