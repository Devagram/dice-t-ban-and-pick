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
import { generateRoomCode, hashToken, mintSeatToken, resumeUrl } from './identity.js'
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
  announceAmendment,
  announceRematch,
  broadcastView,
  relayProgress,
  sendProtocolError,
  sendRejection,
  sendView,
  type SeatSocket,
} from './outbound.js'
import { pairKey } from './PairHistoryDO.js'
import { RateLimiter } from './rateLimit.js'

/**
 * The two seated players, or null if either is anonymous or absent.
 *
 * Read off the log rather than a table: `SEAT_FILLED` carries the identity, so the record of who
 * played is the same record everything else replays from.
 */
function playersOf(state: MatchState): Record<Seat, { id: string; name: string }> | null {
  const found: Partial<Record<Seat, { id: string; name: string }>> = {}
  for (const event of state.log) {
    if (event.payload.type === 'SEAT_FILLED' && event.payload.player) {
      found[event.payload.seat] = event.payload.player
    }
  }
  return found.A && found.B ? { A: found.A, B: found.B } : null
}

/** What one seat drafted, played, and banned. Display data; the log remains the record. */
function seatDetail(state: MatchState, seat: Seat) {
  const slots = state.seats[seat].slots.value
  return {
    drafted: slots.map((s) => s.characterId),
    played: slots.filter((s) => s.consumed).map((s) => s.characterId),
    metaBan: state.seats[seat].metaBanPlaced.value,
  }
}

/** The claim body, treated as untrusted — an older client sends none at all. */
async function readPlayer(request: Request): Promise<{ id: string; name: string } | null> {
  try {
    const body = (await request.json()) as { playerId?: unknown; displayName?: unknown }
    if (typeof body?.playerId !== 'string' || !body.playerId) return null
    const name = typeof body.displayName === 'string' ? body.displayName.slice(0, 40) : ''
    return { id: body.playerId.slice(0, 64), name }
  } catch {
    return null
  }
}

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
  /** Cosmetic traffic, budgeted separately so it can never cost a player an action. */
  private readonly chatter = RateLimiter.forChatter()

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
      case 'rematch':
        return this.handleRematch(url)
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

    // Everything below treats the body as untrusted. The `as` is an assertion, not a check —
    // this endpoint is reachable by anyone with the URL, and a malformed body has to come back
    // as a 400 rather than a 500 with a stack trace in it.
    let body: CreateMatchRequest & { roomCode?: string }
    try {
      body = (await request.json()) as CreateMatchRequest & { roomCode?: string }
    } catch {
      return json({ error: 'MALFORMED_BODY', detail: 'body is not valid JSON' }, 400)
    }
    if (typeof body !== 'object' || body === null) {
      return json({ error: 'MALFORMED_BODY', detail: 'body must be an object' }, 400)
    }

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

    if (body.globalBanned !== undefined && !Array.isArray(body.globalBanned)) {
      return json({ error: 'MALFORMED_BODY', detail: 'globalBanned must be an array' }, 400)
    }
    const globalBanned = [...new Set(body.globalBanned ?? [])].filter(
      (id) => typeof id === 'string',
    )
    globalBanned.sort()
    const allowRepeatBans = body.allowRepeatBans === true
    const viability = this.checkRosterViability(variant, globalBanned, allowRepeatBans)
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
        ruleset: rulesetFor(variant, ROSTER.rosterVersion, globalBanned, allowRepeatBans),
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
    // D31 — the room joins the lobby list the moment it exists. `waitUntil` for the same reason
    // as every other registry write: bookkeeping must not sit between a host and their room.
    this.ctx.waitUntil(
      this.announceRoom(body.roomCode ?? '', {
        modeLabel: variant.mode.label,
        seatsTaken: 0,
        status: 'OPEN',
      }),
    )
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
    allowRepeatBans: boolean,
  ): { error: string; detail: string } | null {
    const banned = new Set(globalBanned)
    const available = activeRoster(ROSTER).filter((id) => !banned.has(id)).length
    /*
     * §13's floor, plus D28.
     *
     * The rule can deny one further character — the ban you brought last set. This check runs at
     * creation, before anyone has sat down and therefore before there is a pairing to look up, so
     * it assumes the worst case rather than the actual history. Guessing optimistically here
     * would move the failure to the ban phase, in front of two people who have already consented
     * by sitting down, which is exactly what §13 exists to prevent.
     */
    const floor = draftCountOf(variant) + 1 + (allowRepeatBans ? 0 : 1)

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

    /*
     * D28 — who is sitting down.
     *
     * Optional, and the match plays exactly as before without it: an older client sends no body,
     * and a seat with no id simply has no history to carry. Self-asserted and unverified (§1's
     * trust model), which is why the *id* is what the rule keys on and the name is only a label.
     */
    const player = await readPlayer(request)
    /*
     * D29 — a seat needs a name.
     *
     * The lobby disables the button without one, but a disabled button is a suggestion. An
     * unnamed seat leaves the match off the leaderboard and gives the no-repeat-ban rule nothing
     * to key on, so the game would behave differently for that player without saying so.
     */
    if (!player || !player.name) {
      return json({ error: 'NAME_REQUIRED', detail: 'take a seat with a name' }, 400)
    }

    const event: EventEnvelope = {
      v: 1,
      seq: state.log.length,
      tag: `seat:${seat}`,
      actor: seat,
      payload: player ? { type: 'SEAT_FILLED', seat, player } : { type: 'SEAT_FILLED', seat },
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

    // D28 — the second seat is the first moment there is a pairing to ask about. A room is opened
    // before anyone sits, so this cannot ride on MATCH_CREATED beside the roster and the ruleset.
    const withHistory = await this.resolvePairing(result.state)

    this.settleAndBroadcast(withHistory)
    this.touch()

    const roomCode = getMeta(this.sql, 'roomCode') ?? ''
    /*
     * D31 — the listing follows the seats.
     *
     * It stays listed once both are taken rather than dropping off, because the room is still
     * worth finding: the owner asked for people to be able to join and watch. `status` is what
     * the list uses to say "join" or "watch", so it has to be accurate at exactly this moment.
     */
    const filled = SEATS.filter((s) => withHistory.seatsFilled[s]).length
    this.ctx.waitUntil(
      this.announceRoom(roomCode, {
        seatsTaken: filled,
        status: filled >= 2 ? 'PLAYING' : 'OPEN',
        // The host is whoever sat in A. Sent only when it is this claim, so a B-seat claim does
        // not overwrite a name already recorded.
        ...(seat === 'A' && player?.name ? { hostName: player.name } : {}),
      }),
    )
    const origin = new URL(request.url).origin || url.origin
    const response: ClaimSeatResponse = {
      seat,
      seatToken: token,
      resumeUrl: resumeUrl(origin, roomCode, token),
      websocketUrl: `${origin.replace(/^http/, 'ws')}/api/match/${roomCode}/ws`,
    }
    return json(response, 201)
  }

  /**
   * D28 — reads the pairing's history and puts it in the log.
   *
   * Returns the state unchanged whenever there is nothing to say: the rule is off, a seat is
   * still empty, either player is anonymous, or the two have never met. Silence is the common
   * case and must cost nothing.
   *
   * The engine learns this the same way it learns the roster — by being handed it — so a replay
   * reproduces the match without consulting a history that has since moved on.
   */
  private async resolvePairing(state: MatchState): Promise<MatchState> {
    if (state.ruleset.constraints.repeatBans !== 'FORBIDDEN') return state
    if (state.log.some((e) => e.payload.type === 'PAIRING_RESOLVED')) return state

    const players = playersOf(state)
    if (!players) return state

    const history = await this.history(players.A.id, players.B.id).fetch('https://pair/recent')
    if (!history.ok) return state
    const { lastBanBy } = (await history.json()) as { lastBanBy: Record<string, string> }

    const denied: Record<Seat, string[]> = {
      A: lastBanBy[players.A.id] ? [lastBanBy[players.A.id]!] : [],
      B: lastBanBy[players.B.id] ? [lastBanBy[players.B.id]!] : [],
    }
    if (denied.A.length === 0 && denied.B.length === 0) return state

    const event: EventEnvelope = {
      v: 1,
      seq: state.log.length,
      tag: 'pairing:resolved',
      actor: 'SYSTEM',
      payload: { type: 'PAIRING_RESOLVED', deniedMetaBans: denied },
    }
    const result = reduce(state, event)
    // A rejection here means the match moved on underneath us, which cannot happen inside a
    // single-threaded DO — but the rule is cosmetic enough that failing the seat claim over it
    // would be the wrong trade.
    if (!result.ok || !tryAppendEvent(this.sql, event)) return state
    return result.state
  }

  /**
   * D28 — records both meta bans once they are placed, for the next set.
   *
   * Fired after a commit settles rather than on a timer: `metaBanPlaced` is the fact, and it is
   * only complete when both seats have it. Writing one at a time would let a half-finished match
   * bind the next one.
   */
  private async recordBans(state: MatchState): Promise<void> {
    if (state.ruleset.constraints.repeatBans !== 'FORBIDDEN') return

    const players = playersOf(state)
    if (!players) return

    const bans: Record<string, string> = {}
    for (const seat of SEATS) {
      const placed = state.seats[seat].metaBanPlaced.value
      if (placed) bans[players[seat].id] = placed
    }
    // Both, or neither. A single ban means the other seat has not committed yet.
    if (Object.keys(bans).length !== SEATS.length) return

    await this.history(players.A.id, players.B.id).fetch('https://pair/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bans }),
    })
  }

  /**
   * D29 — files the result, once the match has one.
   *
   * Upserted by room code, so this is safe to call on every settle and safe to call again after
   * D15's undo reopens a finished match and it finishes differently. Doing it here rather than on
   * a MATCH_COMPLETE hook is deliberate: an undo-then-recomplete produces a *second* completion,
   * and a hook that only fired the first time would leave the leaderboard describing a match that
   * did not happen.
   */
  private async recordResult(state: MatchState): Promise<void> {
    if (state.status !== 'COMPLETE' || state.outcome === null) return

    const players = playersOf(state)
    if (!players) return // an anonymous seat has nothing to put on a leaderboard

    const roomCode = getMeta(this.sql, 'roomCode') ?? ''
    if (!roomCode) return

    const winnerId = state.outcome === 'DRAW' ? null : players[state.outcome as Seat].id

    await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry')).fetch(
      'https://registry/record',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomCode,
          playedAt: Date.now(),
          a: players.A,
          b: players.B,
          winnerId,
          scoreA: state.seats.A.score,
          scoreB: state.seats.B.score,
          // Enough to answer "what do they always play?" — §15's open O6 question — without
          // keeping the event log, which is a separate feature with separate retention.
          detail: {
            rounds: state.rounds.map((r) => r.result),
            seats: {
              A: seatDetail(state, 'A'),
              B: seatDetail(state, 'B'),
            },
          },
        }),
      },
    )
  }

  /**
   * **D32 — play the same match again, without building it again.**
   *
   * A series is the normal way this gets used, and the loop was: go home, re-pick the mode, the
   * parameters and the global bans, create, copy the link, send it. All of that is already known
   * — it is `state.ruleset`, which §5 snapshotted into the creation event precisely so it could
   * be read back later.
   *
   * **Idempotent by room, which is what makes the race a non-event.** Both players will click
   * this; the first creates a room and the second is handed the same code. Stored in meta rather
   * than held in memory because the DO can hibernate between the two clicks.
   *
   * **Does not seat anyone.** It creates the room and points both clients at its ordinary join
   * page. Auto-seating would be a nicer click count and a worse idea: §12.3 makes seating the act
   * of consent, and consenting on someone's behalf because their opponent pressed a button is
   * exactly the thing that rule exists to prevent — even when the ruleset is identical.
   */
  private async handleRematch(url: URL): Promise<Response> {
    const token = url.searchParams.get('token')
    const seat = token ? seatForTokenHash(this.sql, await hashToken(token)) : null
    if (!seat) {
      return json({ error: 'UNAUTHENTICATED', detail: 'a valid seat token is required' }, 401)
    }

    const state = this.rebuild()
    if (!state) return json({ error: 'NO_MATCH', detail: 'nothing has been created here' }, 404)
    if (state.status !== 'COMPLETE') {
      // D15's undo can reopen a finished match, so this is a live condition rather than a
      // formality: a rematch offered mid-match would be a room nobody is coming to.
      return json({ error: 'NOT_COMPLETE', detail: 'the match is still going' }, 409)
    }

    /*
     * Serialised, because the read and the write are separated by an await.
     *
     * Both players press this at once — that is the expected traffic, not an edge case. Without
     * the barrier both requests read an empty `rematchCode`, both create a room, and the two of
     * them end up in different rooms waiting for each other. Reserving the code before the await
     * would fix the race and introduce a worse one: the second client can navigate to a room that
     * does not exist yet. Blocking is the primitive that actually means "one at a time".
     */
    const opened = await this.ctx.blockConcurrencyWhile(async () => {
      const existing = getMeta(this.sql, 'rematchCode')
      if (existing) return { roomCode: existing, fresh: false }

      const created = await this.openRematchRoom(state)
      if (!created) return null
      setMeta(this.sql, 'rematchCode', created)
      return { roomCode: created, fresh: true }
    })

    if (!opened) {
      return json({ error: 'ROOM_CODE_EXHAUSTED', detail: 'could not open a rematch' }, 503)
    }
    if (!opened.fresh) return json({ roomCode: opened.roomCode }, 200)
    const created = opened.roomCode
    // The completed match is the only channel these two still share. Without this the opponent
    // has no way to learn the code, and "play again" is back to sending a link.
    announceRematch(this.sockets(), created, seat)
    return json({ roomCode: created }, 201)
  }

  /**
   * Creates the new room, carrying this match's ruleset across verbatim.
   *
   * Retried on collision for the same reason the router retries: a code that lands on an existing
   * room comes back 409, and silently joining two strangers together would be far worse than a
   * failed button.
   */
  private async openRematchRoom(state: MatchState): Promise<string | null> {
    const { ruleset } = state
    for (let attempt = 0; attempt < 3; attempt++) {
      const roomCode = generateRoomCode()
      const response = await this.env.MATCH.get(this.env.MATCH.idFromName(roomCode)).fetch(
        'https://match/create',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode,
            modeId: ruleset.modeId,
            parameters: ruleset.parameters,
            globalBanned: ruleset.globalBanned,
            // D28 travels with it. A rematch is precisely "the next set", so carrying the host's
            // answer across is the difference between the no-repeat rule applying and quietly
            // lapsing at the moment it was written for.
            allowRepeatBans: ruleset.constraints.repeatBans === 'ALLOWED',
          }),
        },
      )
      if (response.status === 409) continue
      if (response.ok) return roomCode
      return null
    }
    return null
  }

  /**
   * D31 — tells the registry what this room currently is.
   *
   * Failures are swallowed on purpose. A room missing from the lobby list is a discovery problem
   * the join link already solves, and there is no version of this worth failing a seat claim or
   * a completed match over. The TTL sweep is the backstop for anything lost here.
   */
  private async announceRoom(
    roomCode: string,
    fields: {
      modeLabel?: string
      hostName?: string
      seatsTaken?: number
      status: 'OPEN' | 'PLAYING' | 'CLOSED'
    },
  ): Promise<void> {
    if (!roomCode) return
    try {
      await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry')).fetch(
        'https://registry/room',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ roomCode, ...fields }),
        },
      )
    } catch {
      // See the note above.
    }
  }

  private history(a: string, b: string): DurableObjectStub {
    const name = pairKey(a, b)
    return this.env.PAIR_HISTORY.get(this.env.PAIR_HISTORY.idFromName(name))
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

    // Progress is handled before the action budget is touched, and without rebuilding state.
    //
    // It is cosmetic, so it must not be able to cost a player their ability to act — sharing one
    // bucket meant a chatty client got "too many actions; slow down" on its *commit*. It also
    // reads nothing, so folding the whole event log to relay a count was pure waste on the hot
    // path of a feature that fires on every click. Over-quota pings are dropped in silence: an
    // error frame is itself traffic, and there is nothing the player could do about it.
    if (message.type === 'PROGRESS') {
      if (!this.chatter.allow(seat)) return
      // Clamped rather than validated because it decides nothing — a nonsense count should not
      // cost a round trip to reject, and the seat comes from the socket, not the message.
      const of = Math.max(0, Math.min(16, Math.floor(message.of) || 0))
      const filled = Math.max(0, Math.min(of, Math.floor(message.filled) || 0))
      relayProgress(this.sockets(), seat, filled, of, message.ban === true)
      return
    }

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
    // D33 — same rule. Neither correction carries a `seat` field, so both need saying explicitly;
    // an amendment attributed to the other player is what the announcement would then report.
    if (payload.type === 'AMEND_RESULT' && payload.amendedBy !== target.seat) {
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
      const settled = this.settleAndBroadcast(result.state)

      /*
       * D33 — the other seat is told, rather than watching the score move on its own.
       *
       * The new view already carries the corrected result, so this adds no information; what it
       * adds is attribution. Removing D15's undo window removed the thing that stopped a player
       * rewriting an old round, and being told is what replaces it.
       */
      if (payload.type === 'AMEND_RESULT') {
        announceAmendment(this.sockets(), payload.roundIndex, payload.outcome, target.seat)
      }

      /*
       * D28 — remember the bans for next time.
       *
       * Deliberately not awaited. Recording history is bookkeeping for a *future* match; making a
       * player wait on a second Durable Object round trip before their commit is acknowledged
       * would trade a real interaction for a speculative one. `waitUntil` keeps the object alive
       * until it lands, and a failure costs one forgotten ban rather than a stuck match.
       */
      this.ctx.waitUntil(this.recordBans(settled))
      this.ctx.waitUntil(this.recordResult(settled))
      // D31 — and it leaves the lobby list. Only on COMPLETE, so D15's undo reopening a match
      // does not strand a finished room on the list: `settleAndBroadcast` runs again and the
      // room is re-announced by the same code path that removed it.
      this.ctx.waitUntil(
        settled.status === 'COMPLETE'
          ? this.announceRoom(getMeta(this.sql, 'roomCode') ?? '', { status: 'CLOSED' })
          : this.announceRoom(getMeta(this.sql, 'roomCode') ?? '', {
              seatsTaken: 2,
              status: 'PLAYING',
            }),
      )
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
  private settleAndBroadcast(state: MatchState): MatchState {
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
    return current
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
