/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'
import {
  buildBracket,
  champion,
  isComplete,
  readySlots,
  rederive,
  roundsFor,
  bracketSize,
  views,
  viewOf,
  downstreamOf,
  MAX_ENTRANTS,
  MIN_ENTRANTS,
  type BracketState,
  type Entrant,
  type ResultEntry,
  type SlotView,
} from '@banpick/bracket'

import rosterAsset from '../../../roster/roster.json' with { type: 'json' }
import { generateRoomCode, hashToken, mintEntrantToken } from './identity.js'
import { broadcastBracket, sendProtocolError } from './outbound.js'
import {
  positionOf,
  resolveConfig,
  ConfigError,
  type BracketPosition,
  type ResolvedTournamentConfig,
  type TournamentConfigInput,
} from './tournamentConfig.js'

/**
 * **D37 — one Durable Object per tournament, and the authority for its bracket.**
 *
 * It owns storage and provisioning and holds **no bracket logic of its own**: every question about
 * who plays whom goes to `@banpick/bracket`, which is pure and exhaustively tested under Node.
 * That split is the same one `MatchDO` makes with `@banpick/engine`, for the same reason — the
 * hard part is testable without a runtime, and the runtime part has nothing clever in it.
 *
 * **Scale, stated rather than discovered.** One object serialises every write, exactly as
 * `RegistryDO` warns of itself. That is right at D42's cap of 32 entrants and wrong at 500; if it
 * ever matters the fix is to shard by bracket half and aggregate, and this comment is the warning
 * that nobody did. The cap is enforced at creation rather than left as a hope.
 *
 * **Nothing is stored that can be derived.** The bracket is a fold over the result log, recomputed
 * on read — the same argument `RegistryDO` makes about totals being counted rather than
 * incremented, and it earns more here, because D39's correction path is literally "append a
 * corrected result and read again". A cached bracket would be a second truth.
 */

/** D42 — seven days from the last activity, then swept. */
export const TOURNAMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Deliberately **not** `ROOM_TTL_MS`, which is two hours.
 *
 * They are two different questions wearing one word. A room in the open lobby list (D31) is an
 * invitation, and the short sweep exists because "a lobby full of dead rooms is worse than an
 * empty one — every entry is a click that goes nowhere". A tournament is a commitment that spans
 * evenings. Cross-referenced from `RegistryDO` so the difference reads as a decision rather than
 * as an inconsistency somebody should tidy up.
 */

export type TournamentStatus = 'REGISTERING' | 'RUNNING' | 'COMPLETE' | 'ABANDONED'

export interface EntrantInput {
  playerId?: unknown
  displayName?: unknown
  seed?: unknown
}

/** What the public page reads. No tokens, ever — see `entrantsPublic`. */
export interface TournamentView {
  code: string
  status: TournamentStatus
  format: string
  grandFinalReset: boolean
  createdAt: number
  entrants: { entrantId: string; playerId: string; displayName: string; seed: number }[]
  slots: (SlotView & { position: BracketPosition; modeId: string; roomCode: string | null })[]
  champion: string | null
  complete: boolean
}

interface Row {
  [key: string]: string | number | null
}

interface TournamentRow {
  code: string
  status: string
  config: string
  seeding_seed: string
  created_at: number
  updated_at: number
}

export class TournamentDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.migrate()
    })
  }

  /**
   * Creates every table if it is missing.
   *
   * Called from the constructor **and after the D42 sweep**, and the second one is the reason it is
   * a method. `deleteAll()` takes the tables with it, and the instance stays alive afterwards — so
   * a request arriving between the sweep and the eviction found no `tournament` table and threw
   * `SQLITE_ERROR` instead of answering 404. A swept tournament should look like one that never
   * existed, which is what re-creating the empty schema makes true.
   */
  private migrate(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS tournament (
           id          INTEGER PRIMARY KEY CHECK (id = 1),
           code        TEXT NOT NULL,
           status      TEXT NOT NULL,
           config      TEXT NOT NULL,
           seeding_seed TEXT NOT NULL,
           created_at  INTEGER NOT NULL,
           updated_at  INTEGER NOT NULL
         )`,
    )
    /*
     * D37 Phase 7 — the organizer's credential.
     *
     * Deliberately **not** `ADMIN_KEY`. That key is deployment-wide and gates rewriting every
     * recorded result in the deployment; running a tournament should not require it, and
     * handing it to whoever is running Thursday's event is how it leaks. One token per
     * tournament, minted at creation, hashed like every other credential here.
     */
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS organizer (
           id         INTEGER PRIMARY KEY CHECK (id = 1),
           token_hash TEXT NOT NULL
         )`,
    )
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS entrants (
           entrant_id  TEXT PRIMARY KEY,
           player_id   TEXT NOT NULL,
           display_name TEXT NOT NULL,
           seed        INTEGER NOT NULL,
           -- D41. Hashed, like a seat token in persistence.ts: the plaintext is returned once at
           -- creation and never again, so a dump of this table is not a set of credentials.
           token_hash  TEXT NOT NULL
         )`,
    )
    /*
     * The result log. Append-only and ordered — D39's correction is a later row for the same
     * slot, never an update, so "what did we think at the time" stays answerable.
     */
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS results (
           seq       INTEGER PRIMARY KEY AUTOINCREMENT,
           slot_id   TEXT NOT NULL,
           type      TEXT NOT NULL,
           winner    TEXT,
           recorded_at INTEGER NOT NULL
         )`,
    )
    /*
     * D39 — who decided, and why.
     *
     * Added by `ALTER TABLE` rather than folded into the `CREATE` above, for the same reason
     * `RegistryDO`'s `tournament_id` was: a `CREATE TABLE IF NOT EXISTS` with a new column is a
     * no-op against a table that already exists, so the column would never appear.
     *
     * An organizer overruling two players is a different event from those two players agreeing,
     * and a log that cannot tell them apart cannot answer the only question anybody asks
     * afterwards.
     */
    for (const column of ['decided_by TEXT', 'reason TEXT']) {
      try {
        this.sql.exec(`ALTER TABLE results ADD COLUMN ${column}`)
      } catch {
        // Already present.
      }
    }
    /*
     * Which room a slot's match was opened in. Not part of the bracket — the bracket is entrants
     * and results — and deliberately separable: a tournament outlives its `MatchDO`s, so this is
     * a pointer that is allowed to go stale without the record losing anything.
     */
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS provisioned (
           slot_id   TEXT PRIMARY KEY,
           room_code TEXT NOT NULL,
           opened_at INTEGER NOT NULL
         )`,
    )
  }

  /**
   * **The organizer door, and it fails closed.**
   *
   * The same rule `ADMIN_KEY` follows (D34): a tournament with no organizer token has **no
   * organizer**, not an open one. That case cannot arise for anything created after Phase 7 —
   * the token is minted at creation — but "cannot arise" is a claim about today's code, and this
   * is the check that makes it a property.
   *
   * Constant-time comparison on the hash, matching `index.ts`'s admin check. The hash of an
   * attacker-supplied token reveals nothing about the stored one through timing, but the habit is
   * worth more than the exception.
   */
  private async organizerOk(request: Request): Promise<Response | null> {
    const row = this.sql.exec<Row>('SELECT token_hash FROM organizer WHERE id = 1').toArray()[0]
    if (!row) {
      return Response.json(
        {
          error: 'NO_ORGANIZER',
          detail: 'this tournament has no organizer token, so it has no organizer',
        },
        { status: 503 },
      )
    }
    const offered = request.headers.get('x-organizer-key') ?? ''
    if (!offered || (await hashToken(offered)) !== String(row['token_hash'])) {
      return Response.json(
        { error: 'UNAUTHORIZED', detail: 'bad or missing organizer key' },
        { status: 401 },
      )
    }
    return null
  }

  /** Every mutation an organizer can make. Listed so the gate cannot be forgotten for a new one. */
  private static readonly ORGANIZER_ACTIONS = new Set([
    'provision',
    'relink',
    'resolve',
    'voidSlot',
    'correct',
    'reseed',
    'entrants',
  ])

  override async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? ''

    /*
     * Gated by an allowlist rather than a check inside each handler.
     *
     * A per-handler check is one `if` away from being missed on the day somebody adds the eighth
     * action, and the failure mode is silent: the endpoint simply works for everybody. This way
     * the mistake is forgetting to *add* to the list, which leaves the new action ungated —
     * so the list and the switch are kept adjacent, and the exit test walks every route.
     */
    if (TournamentDO.ORGANIZER_ACTIONS.has(action)) {
      const refusal = await this.organizerOk(request)
      if (refusal) return refusal
    }

    switch (action) {
      case 'create':
        return this.create(request)
      case 'view':
        return this.view()
      case 'provision':
        return this.provision(request)
      case 'authorize':
        return this.authorize(request)
      case 'report':
        return this.report(request)
      case 'relink':
        return this.relink(request)
      case 'resolve':
        return this.resolve(request)
      case 'voidSlot':
        return this.organizerVoid(request)
      case 'correct':
        return this.correct(request)
      case 'cascade':
        return this.cascade(request)
      case 'reseed':
        return this.reseed(request)
      case 'entrants':
        return this.editEntrants(request)
      case 'ws':
        return this.handleWebSocket(request)
      default:
        return Response.json(
          { error: 'NOT_FOUND', detail: `no action '${action}'` },
          { status: 404 },
        )
    }
  }

  /**
   * D42 — seven days idle, then the storage goes.
   *
   * An alarm rather than a sweep-on-read, because nothing enumerates tournaments: `RegistryDO` can
   * delete stale rows when somebody asks for the lobby list, and there is no equivalent moment
   * here. A Durable Object that nobody ever fetches again would otherwise hold its rows forever.
   *
   * Re-armed on every write (`touch`), so the clock measures **idleness** and a tournament running
   * across three weekends is never swept out from under itself.
   */
  override async alarm(): Promise<void> {
    const meta = this.meta()
    if (!meta) return
    if (Date.now() - meta.updated_at < TOURNAMENT_TTL_MS) {
      // Something happened after the alarm was set. Re-arm from the real last activity rather
      // than deleting on a stale schedule.
      await this.ctx.storage.setAlarm(meta.updated_at + TOURNAMENT_TTL_MS)
      return
    }
    await this.ctx.storage.deleteAll()
    // The instance outlives the delete. Without this, the next request to reach it before eviction
    // finds no tables at all and fails as a 500 rather than as the 404 a swept tournament is.
    this.migrate()
  }

  /**
   * D37 Phase 8 — files a summary with the registry, which outlives this object.
   *
   * This one is swept seven days after its last activity (D42), and that is right for a bracket
   * nobody has touched in a week. But "nobody has touched it in a week" is usually the same week
   * somebody wants to look up who won, so the durable record cannot live here.
   *
   * The summary goes every time; the **bracket itself only once the tournament is finished**. A
   * running one has this object to answer for it, and a second copy that could disagree with the
   * live one is worse than no copy. A finished one has nothing else that can draw it — the match
   * rows carry no slot ids and no edges, and a slot the organizer resolved never produced a match
   * at all — so the final bracket is filed, and re-filed as `null` if D39's correction makes a
   * finished tournament unfinished again.
   */
  private async fileWithRegistry(): Promise<void> {
    const meta = this.meta()
    if (!meta) return
    const bracket = this.bracket(meta)
    const winner = champion(bracket)
    const finished = isComplete(bracket)

    await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry')).fetch(
      'https://registry/tournament',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: meta.code,
          format: bracket.format,
          entrants: bracket.entrants.map((e) => e.displayName),
          champion: winner
            ? (bracket.entrants.find((e) => e.entrantId === winner)?.displayName ?? winner)
            : null,
          createdAt: meta.created_at,
          complete: finished,
          view: finished ? this.currentView() : null,
        }),
      },
    )
  }

  /** Records activity and pushes the sweep out. Every write goes through here. */
  private async touch(): Promise<void> {
    const now = Date.now()
    this.sql.exec('UPDATE tournament SET updated_at = ? WHERE id = 1', now)
    await this.ctx.storage.setAlarm(now + TOURNAMENT_TTL_MS)
    /*
     * Filed on every write for the same reason the broadcast is: hanging it off the one function
     * every write already calls means it cannot be forgotten for a new action. Not awaited — the
     * index being a moment behind costs nothing, and making an organizer wait on a second object
     * before their correction is acknowledged would trade a real interaction for a bookkeeping one.
     */
    this.ctx.waitUntil(this.fileWithRegistry())
    /*
     * Every write goes through here, so every write reaches the watchers — a slot resolving, a
     * match being provisioned, an entrant relinked, the tournament completing. Piggy-backing on
     * `touch` rather than remembering to call `broadcast` at each site is deliberate: the failure
     * mode of the alternative is a bracket that is right on refresh and stale on screen, which is
     * the hardest kind of wrong to notice.
     */
    this.broadcast()
  }

  // --- Creation ---------------------------------------------------------------------------------

  private async create(request: Request): Promise<Response> {
    if (this.meta()) {
      return Response.json({ error: 'ALREADY_EXISTS' }, { status: 409 })
    }

    let body: {
      code?: unknown
      entrants?: unknown
      seedingSeed?: unknown
      config?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    if (typeof body.code !== 'string' || !body.code) {
      return Response.json({ error: 'MALFORMED_BODY', detail: 'missing code' }, { status: 400 })
    }

    const parsed = parseEntrants(body.entrants)
    if ('error' in parsed) {
      return Response.json({ error: 'BAD_ENTRANTS', detail: parsed.error }, { status: 400 })
    }

    let config: ResolvedTournamentConfig
    try {
      config = resolveConfig(
        (body.config ?? {}) as TournamentConfigInput,
        (rosterAsset as { rosterVersion: string }).rosterVersion,
      )
    } catch (e) {
      if (e instanceof ConfigError) {
        return Response.json({ error: e.code, at: e.at, detail: e.message }, { status: 400 })
      }
      throw e
    }

    /*
     * Build the bracket now, before storing anything.
     *
     * Not because the structure is persisted — it is not, it is rebuilt on every read — but
     * because `buildBracket` is where the entrant count, the seeding, and D42's cap are checked,
     * and a tournament that cannot produce a bracket should never reach storage at all. Failing
     * here is a 400; failing on first read would be a tournament that exists and cannot be looked
     * at.
     */
    const seedingSeed = typeof body.seedingSeed === 'string' ? body.seedingSeed : body.code
    let bracket: BracketState
    try {
      bracket = buildBracket(config.format, parsed.entrants, {
        seeding: config.seeding,
        seedingSeed,
        grandFinalReset: config.grandFinalReset,
      })
    } catch (e) {
      return Response.json(
        { error: 'BAD_BRACKET', detail: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      )
    }

    const now = Date.now()
    const tokens: Record<string, string> = {}
    for (const entrant of bracket.entrants) {
      const token = mintEntrantToken()
      tokens[entrant.entrantId] = token
      this.sql.exec(
        `INSERT INTO entrants (entrant_id, player_id, display_name, seed, token_hash)
           VALUES (?, ?, ?, ?, ?)`,
        entrant.entrantId,
        entrant.playerId,
        entrant.displayName,
        entrant.seed,
        await hashToken(token),
      )
    }

    /*
     * The organizer's token, minted once and returned once — the same contract as an entrant's.
     *
     * Deliberately not `ADMIN_KEY`: that one is deployment-wide and gates rewriting every recorded
     * result in the deployment. Running Thursday's tournament should not require it, and handing
     * it out so somebody can is exactly how it leaks.
     */
    const organizerToken = mintEntrantToken()
    this.sql.exec(
      'INSERT INTO organizer (id, token_hash) VALUES (1, ?)',
      await hashToken(organizerToken),
    )

    this.sql.exec(
      `INSERT INTO tournament (id, code, status, config, seeding_seed, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      body.code,
      'RUNNING' satisfies TournamentStatus,
      JSON.stringify(config),
      seedingSeed,
      now,
      now,
    )
    await this.touch()

    /*
     * Open round one immediately.
     *
     * Awaited rather than deferred: the response tells entrants where to go, and a tournament that
     * exists with no playable match is a page that says "waiting" for no reason anybody can see.
     * Every later provisioning run rides on a result instead.
     */
    await this.provision(request)

    /*
     * The tokens are returned **once**, here, and never again — the same contract D17 gives a seat
     * token. A later read cannot recover them because only the hashes are stored, which is what
     * makes "the organizer re-mints one" (D41) the recovery path rather than a convenience.
     */
    return Response.json(
      {
        ok: true,
        code: body.code,
        organizerToken,
        entrants: bracket.entrants.map((e) => ({
          entrantId: e.entrantId,
          displayName: e.displayName,
          seed: e.seed,
          entrantToken: tokens[e.entrantId]!,
        })),
      },
      { status: 201 },
    )
  }

  // --- Reading ----------------------------------------------------------------------------------

  private view(): Response {
    const view = this.currentView()
    return view ? Response.json(view) : Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  /**
   * The bracket as anybody sees it — one builder for the HTTP read and the socket frame.
   *
   * Two builders would be two answers, and the one that drifts is always the one fewer people
   * look at. `null` only before creation.
   */
  private currentView(): TournamentView | null {
    const meta = this.meta()
    if (!meta) return null

    const bracket = this.bracket(meta)
    const config = JSON.parse(meta.config) as ResolvedTournamentConfig
    const size = bracketSize(bracket.entrants.length)
    const winnersRounds = roundsFor(size)
    const losersRounds = Math.max(0, 2 * (winnersRounds - 1))
    const rooms = this.rooms()

    const view: TournamentView = {
      code: meta.code,
      status: isComplete(bracket) ? 'COMPLETE' : (meta.status as TournamentStatus),
      format: bracket.format,
      grandFinalReset: bracket.grandFinalReset,
      createdAt: meta.created_at,
      entrants: bracket.entrants.map((e) => ({
        entrantId: e.entrantId,
        playerId: e.playerId,
        displayName: e.displayName,
        seed: e.seed,
      })),
      slots: views(bracket).map((v) => {
        const position = positionOf(v.slot, winnersRounds, losersRounds)
        return {
          ...v,
          position,
          modeId: config.positions[position].modeId,
          roomCode: rooms.get(v.slot.id) ?? null,
        }
      }),
      champion: champion(bracket),
      complete: isComplete(bracket),
    }

    return view
  }

  // --- Live bracket -----------------------------------------------------------------------------

  /**
   * **Spectators are first-class, and that is the whole shape of this endpoint.**
   *
   * No token, no seat, no authentication of any kind. A bracket is public for the same reason
   * D31's lobby list and D34's history are, and most people looking at one are not playing in it —
   * so requiring a credential would be gating the common case on the rare one.
   *
   * Uses **hibernation**, like `MatchDO`'s: a tournament runs for a week (D42), and an object held
   * awake by a dozen idle spectators for that long is exactly the cost §11's headroom table was
   * written to avoid. No tags, because there is nothing to distinguish one watcher from another —
   * everybody gets the same frame, which is the honest consequence of the bracket being public.
   */
  private handleWebSocket(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json(
        { error: 'EXPECTED_UPGRADE', detail: 'this endpoint speaks WebSocket' },
        { status: 426 },
      )
    }
    if (!this.meta()) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)

    // The full bracket immediately, so a reconnect is not a special case — the same argument D17
    // makes for resyncing a match rather than shipping deltas.
    broadcastBracket([server], this.currentView())
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * The socket is **read-only**, and says so rather than ignoring what it is sent.
   *
   * Everything that changes a bracket happens over HTTP — a match reporting a result, an organizer
   * correcting one. A watcher has nothing to send, and a silent drop would leave somebody
   * wondering whether their message went somewhere.
   */
  override async webSocketMessage(socket: WebSocket): Promise<void> {
    sendProtocolError(socket, 'MALFORMED', 'the bracket socket is read-only')
  }

  /** Every change goes out in full to everyone watching. Cheap at 32 entrants; see the scale note. */
  private broadcast(): void {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    broadcastBracket(sockets, this.currentView())
  }

  // --- Provisioning -----------------------------------------------------------------------------

  /**
   * Opens a room for every ready slot that has not got one.
   *
   * Idempotent, and deliberately **pull rather than push**: called after anything that could make
   * a slot ready rather than triggered from inside the advancement path. A slot that already has a
   * room is skipped, so a retry after a half-finished provisioning run finishes the job instead of
   * opening a second room for the same match.
   *
   * The ruleset comes from the tournament's snapshotted config, not from whoever opened the room —
   * which is G8's "organizer-owned ruleset" affordance, declined by D19 and reinstated by D37. The
   * `MatchDO` is addressed directly rather than through `/api/match`, because that route
   * deliberately refuses to attach a tournament binding to anything.
   */
  private async provision(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const origin = new URL(request.url).origin
    const config = JSON.parse(meta.config) as ResolvedTournamentConfig
    const bracket = this.bracket(meta)
    const size = bracketSize(bracket.entrants.length)
    const winnersRounds = roundsFor(size)
    const losersRounds = Math.max(0, 2 * (winnersRounds - 1))
    const existing = this.rooms()

    const opened: { slotId: string; roomCode: string }[] = []

    for (const slot of readySlots(bracket)) {
      if (existing.has(slot.id)) continue
      const position = positionOf(slot, winnersRounds, losersRounds)
      const mode = config.positions[position]

      const roomCode = generateRoomCode()
      const response = await this.env.MATCH.get(this.env.MATCH.idFromName(roomCode)).fetch(
        `${origin}/create`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            roomCode,
            modeId: mode.modeId,
            parameters: mode.parameters,
            globalBanned: config.globalBanned,
            allowRepeatBans: config.allowRepeatBans,
            // D37 — the binding. Snapshotted into MATCH_CREATED and never dereferenced for rules;
            // it is used to ask *this* object who may sit down and to report the result back.
            tournament: { code: meta.code, slotId: slot.id },
          }),
        },
      )
      // A code collision lands on an existing match and returns 409. Skipping rather than
      // retrying is fine: the next `provision` call picks the slot up with a fresh code.
      if (!response.ok) continue

      this.sql.exec(
        'INSERT OR IGNORE INTO provisioned (slot_id, room_code, opened_at) VALUES (?, ?, ?)',
        slot.id,
        roomCode,
        Date.now(),
      )
      opened.push({ slotId: slot.id, roomCode })
    }

    if (opened.length > 0) await this.touch()
    return Response.json({ ok: true, opened })
  }

  /**
   * D41 — may this token sit in this slot, and in which seat?
   *
   * **Asked live rather than snapshotted into the match, and that is the one place this design
   * departs from §11's snapshot-everything instinct.** A match's *rules* must not change under it,
   * so the ruleset is frozen at creation. Who may sit is not a rule — it is precisely the thing an
   * organizer may need to correct mid-event when somebody loses their token or turns up on a
   * different laptop. Freezing the token hashes into the match would make `relink` a lie for every
   * room already open.
   *
   * The response carries the entrant's **registered** player id and name, and `MatchDO` seats them
   * under those rather than under whatever the browser claimed. That is what stops D35's duplicate
   * ids recurring inside a tournament: play from a new phone and the leaderboard still credits the
   * person the organizer entered.
   */
  private async authorize(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    let body: { slotId?: unknown; token?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    const token = typeof body.token === 'string' ? body.token : ''
    if (!slotId || !token) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    const bracket = this.bracket(meta)
    const slot = bracket.slots.find((s) => s.id === slotId)
    if (!slot) return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })

    const view = viewOf(bracket, slot)
    const hash = await hashToken(token)
    const row = this.sql.exec<Row>('SELECT * FROM entrants WHERE token_hash = ?', hash).toArray()[0]

    if (!row) {
      // Distinguished from NOT_IN_MATCH on purpose: "that link is not for this tournament" and
      // "that link is for a different match" send somebody to look in two different places.
      return Response.json(
        { error: 'UNKNOWN_TOKEN', detail: 'that entrant link is not for this tournament' },
        { status: 403 },
      )
    }

    const entrantId = String(row['entrant_id'])
    const index = view.entrants.indexOf(entrantId)
    if (index === -1) {
      return Response.json(
        { error: 'NOT_IN_MATCH', detail: 'you are not one of the two players in this match' },
        { status: 403 },
      )
    }

    return Response.json({
      ok: true,
      entrantId,
      // The bracket's first side is seat A. Assigned rather than first-come, which is right for
      // D31's open lobby and wrong for a match two named people are scheduled to play.
      seat: index === 0 ? 'A' : 'B',
      playerId: String(row['player_id']),
      displayName: String(row['display_name']),
    })
  }

  /**
   * A tournament match finished. Records what happened and opens whatever it unlocked.
   *
   * A **draw** is recorded as `DRAWN` rather than dropped. D21 makes a level match a legal
   * terminal state and D36's Bo1 allows a tied round outright, so a tournament using either can
   * produce a match with no winner — and a bracket that silently ignored it would stall with no
   * explanation anywhere. It waits for the organizer instead, which is the same answer D38 gives a
   * dispute and for the same reason: replay, coin toss or walkover are all defensible, and none of
   * them is the app's call.
   */
  private async report(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    let body: {
      slotId?: unknown
      winnerPlayerId?: unknown
      drawn?: unknown
      disputed?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    if (!slotId) return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })

    const bracket = this.bracket(meta)
    const slot = bracket.slots.find((s) => s.id === slotId)
    if (!slot) return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })

    if (body.disputed === true) {
      // D38 — recorded so the organizer can see it while it is happening. No freeze: nothing has
      // been consumed, the two seats can still agree between themselves, and taking the undo away
      // from them would turn every fat finger into an escalation.
      this.recordResult(slotId, 'DISPUTE', null)
      await this.touch()
      return Response.json({ ok: true, recorded: 'DISPUTE' })
    }

    if (body.drawn === true) {
      this.recordResult(slotId, 'DRAWN', null)
      await this.touch()
      return Response.json({ ok: true, recorded: 'DRAWN' })
    }

    /*
     * The match names the winner by **player id**; the entrant id is this object's own handle and
     * `MatchDO` has no business knowing it. Mapping here also means a D41 relink is picked up
     * automatically — the entrant row is the single place the two identities meet.
     */
    const winnerPlayerId = typeof body.winnerPlayerId === 'string' ? body.winnerPlayerId : ''
    const row = this.sql
      .exec<Row>('SELECT entrant_id FROM entrants WHERE player_id = ?', winnerPlayerId)
      .toArray()[0]
    const winner = row ? String(row['entrant_id']) : ''

    const view = viewOf(bracket, slot)
    if (!winner || !view.entrants.includes(winner)) {
      return Response.json(
        { error: 'NOT_IN_SLOT', detail: `'${winnerPlayerId}' is not in slot '${slotId}'` },
        { status: 400 },
      )
    }

    /*
     * Upserted by appending, and safe to call again — D15's undo can reopen a finished match and
     * complete it differently, which produces a *second* report. The log keeps both and the last
     * one wins, so the bracket follows without anybody having to detect the replay.
     */
    this.recordResult(slotId, 'WIN', winner)
    await this.touch()

    // Whatever that unlocked, open it now rather than waiting for somebody to ask.
    await this.provision(request)

    /*
     * **D39 — the result is consumed, and the answer says so rather than the tournament reaching
     * back to enforce it.**
     *
     * The first version had this object fetch the match's `/freeze` endpoint here, which is a
     * Durable Object calling back into the one that just called it — a cycle, and it hung: the
     * match's report never returned, so `provision` never ran and the next round never opened. The
     * symptom was a bracket that advanced correctly and then simply stopped.
     *
     * So consumption is **reported, not imposed**. `MatchDO` hears "consumed" in the reply it was
     * already waiting for and freezes itself. Same guarantee, no cycle, and one fewer public
     * capability on the match.
     */
    return Response.json({ ok: true, recorded: 'WIN', consumed: true })
  }

  private recordResult(
    slotId: string,
    type: string,
    winner: string | null,
    decidedBy: 'PLAYERS' | 'ORGANIZER' = 'PLAYERS',
    reason: string | null = null,
  ): void {
    this.sql.exec(
      `INSERT INTO results (slot_id, type, winner, recorded_at, decided_by, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
      slotId,
      type,
      winner,
      Date.now(),
      decidedBy,
      reason,
    )
  }

  // --- Phase 7: the organizer -----------------------------------------------------------------

  /**
   * **Settles a slot the players could not.**
   *
   * One action for three situations, because they are the same act with different reasons: a
   * `DISPUTED` slot where two people disagreed (D38), a `DRAWN` one where nobody won, and a
   * walkover where somebody did not turn up. Splitting them into three endpoints would triple the
   * surface to say one thing — *the organizer has decided this* — and the reason is what
   * distinguishes them, so the reason is what gets recorded.
   *
   * The log keeps the earlier entries. An organizer overruling two players is a different event
   * from those two players agreeing, and `decided_by` is what lets anybody tell afterwards.
   */
  private async resolve(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as {
      slotId?: unknown
      winnerEntrantId?: unknown
      reason?: unknown
    }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    const winner = typeof body.winnerEntrantId === 'string' ? body.winnerEntrantId : ''
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : ''

    const bracket = this.bracket(meta)
    const slot = bracket.slots.find((s) => s.id === slotId)
    if (!slot) return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })

    const view = viewOf(bracket, slot)
    if (!view.entrants.includes(winner)) {
      return Response.json(
        { error: 'NOT_IN_SLOT', detail: `'${winner}' is not in slot '${slotId}'` },
        { status: 400 },
      )
    }
    if (!reason) {
      // Required, not optional. A forced advancement with no reason is indistinguishable a week
      // later from one somebody made up, and this is the log people will argue over.
      return Response.json(
        { error: 'REASON_REQUIRED', detail: 'say why the organizer decided this' },
        { status: 400 },
      )
    }

    this.recordResult(slotId, 'WIN', winner, 'ORGANIZER', reason)
    await this.touch()
    await this.provision(request)
    return Response.json({ ok: true })
  }

  /** D39 — takes a slot out of play without deciding it. The match is re-run, or it is not. */
  private async organizerVoid(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as { slotId?: unknown; reason?: unknown }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : ''
    if (!this.bracket(meta).slots.some((s) => s.id === slotId)) {
      return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })
    }
    if (!reason) {
      return Response.json({ error: 'REASON_REQUIRED' }, { status: 400 })
    }

    this.recordResult(slotId, 'VOID', null, 'ORGANIZER', reason)
    // The room is dropped so the slot provisions a fresh one when it next becomes ready — a
    // re-run in the room that produced the voided result would replay into the same match log.
    this.sql.exec('DELETE FROM provisioned WHERE slot_id = ?', slotId)
    await this.touch()
    await this.provision(request)
    return Response.json({ ok: true })
  }

  /**
   * **D39 — what a correction would cost, before it is applied.**
   *
   * Read-only and ungated, because it changes nothing and the bracket it describes is public. The
   * split is the important part: matches **not yet played** downstream are simply invalidated and
   * the app can say so, but matches that were **already played** are real games between real
   * people, and whether they still count is a judgement about the evening that D39 refuses to make
   * on the organizer's behalf.
   */
  private async cascade(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as { slotId?: unknown }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    const bracket = this.bracket(meta)
    if (!bracket.slots.some((s) => s.id === slotId)) {
      return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })
    }

    const downstream = downstreamOf(bracket, slotId)
    const played: string[] = []
    const pending: string[] = []
    for (const id of downstream) {
      const slot = bracket.slots.find((s) => s.id === id)!
      ;(viewOf(bracket, slot).winner !== null ? played : pending).push(id)
    }

    return Response.json({ slotId, played, pending })
  }

  /**
   * D39 — changes a consumed result, and re-derives everything that followed from it.
   *
   * Appends rather than edits, so the bracket before and after are both derivable from one log and
   * "what did we think at the time" stays answerable. Downstream slots that were only *waiting*
   * simply recompute; downstream slots that were **played** are voided here only if the organizer
   * says so, having been shown them by `cascade` first.
   */
  private async correct(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as {
      slotId?: unknown
      winnerEntrantId?: unknown
      reason?: unknown
      voidDownstream?: unknown
    }
    const slotId = typeof body.slotId === 'string' ? body.slotId : ''
    const winner = typeof body.winnerEntrantId === 'string' ? body.winnerEntrantId : ''
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : ''

    const bracket = this.bracket(meta)
    const slot = bracket.slots.find((s) => s.id === slotId)
    if (!slot) return Response.json({ error: 'UNKNOWN_SLOT' }, { status: 404 })
    if (!reason) return Response.json({ error: 'REASON_REQUIRED' }, { status: 400 })
    if (!viewOf(bracket, slot).entrants.includes(winner)) {
      return Response.json({ error: 'NOT_IN_SLOT' }, { status: 400 })
    }

    const voided: string[] = []
    if (body.voidDownstream === true) {
      for (const id of downstreamOf(bracket, slotId)) {
        const downstreamSlot = bracket.slots.find((s) => s.id === id)!
        if (viewOf(bracket, downstreamSlot).winner === null) continue
        this.recordResult(id, 'VOID', null, 'ORGANIZER', `voided by a correction to ${slotId}`)
        this.sql.exec('DELETE FROM provisioned WHERE slot_id = ?', id)
        voided.push(id)
      }
    }

    this.recordResult(slotId, 'WIN', winner, 'ORGANIZER', reason)
    await this.touch()
    await this.provision(request)
    return Response.json({ ok: true, voided })
  }

  /**
   * Re-seeds, **before the first match only**.
   *
   * After that it is not a re-seed, it is rebuilding the bracket around games people have already
   * played — which would move somebody who won into a slot they never played, and the honest name
   * for that is a different tournament.
   */
  private async reseed(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    if (this.results().length > 0) {
      return Response.json(
        {
          error: 'ALREADY_STARTED',
          detail: 'a result has been recorded; re-seeding now would move played games',
        },
        { status: 409 },
      )
    }

    const body = (await request.json().catch(() => ({}))) as { order?: unknown }
    if (!Array.isArray(body.order)) {
      return Response.json(
        { error: 'MALFORMED_BODY', detail: 'order must be entrant ids' },
        { status: 400 },
      )
    }

    const existing = this.sql.exec<Row>('SELECT entrant_id FROM entrants').toArray()
    const ids = new Set(existing.map((r) => String(r['entrant_id'])))
    if (body.order.length !== ids.size || body.order.some((id) => !ids.has(String(id)))) {
      return Response.json(
        { error: 'MALFORMED_BODY', detail: 'order must list every entrant exactly once' },
        { status: 400 },
      )
    }

    for (const [i, id] of body.order.entries()) {
      this.sql.exec('UPDATE entrants SET seed = ? WHERE entrant_id = ?', i + 1, String(id))
    }
    // Every room was opened against the old seeding, so they are all wrong now.
    this.sql.exec('DELETE FROM provisioned')
    await this.touch()
    await this.provision(request)
    return Response.json({ ok: true })
  }

  /**
   * Substitutes an entrant. **Substitution only, never removal**, once anything has been played.
   *
   * Removing somebody mid-bracket leaves a slot with one side and no way to fill it, and adding
   * somebody means a different bracket. A substitution keeps the shape and changes who is standing
   * in it, which is the only one of the three that a bracket can absorb — and it is also what
   * actually happens at a table when somebody has to leave.
   */
  private async editEntrants(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    const body = (await request.json().catch(() => ({}))) as {
      entrantId?: unknown
      playerId?: unknown
      displayName?: unknown
    }
    const entrantId = typeof body.entrantId === 'string' ? body.entrantId : ''
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : ''
    const playerId = typeof body.playerId === 'string' ? body.playerId.trim() : ''
    if (!entrantId || !displayName || !playerId) {
      return Response.json(
        {
          error: 'MALFORMED_BODY',
          detail: 'a substitution needs entrantId, playerId and displayName',
        },
        { status: 400 },
      )
    }

    const row = this.sql
      .exec<Row>('SELECT * FROM entrants WHERE entrant_id = ?', entrantId)
      .toArray()[0]
    if (!row) return Response.json({ error: 'UNKNOWN_ENTRANT' }, { status: 404 })

    // A fresh token, because it is a different person: the one the departing entrant holds must
    // stop working at the same moment.
    const token = mintEntrantToken()
    this.sql.exec(
      'UPDATE entrants SET player_id = ?, display_name = ?, token_hash = ? WHERE entrant_id = ?',
      playerId,
      displayName,
      await hashToken(token),
      entrantId,
    )
    await this.touch()
    return Response.json({ ok: true, entrantId, entrantToken: token })
  }

  /**
   * D41 — point an entrant at a different player id, and mint them a fresh token.
   *
   * The recovery path when a token is lost, and D35's merge scoped to one event. The endpoint
   * lives here beside the thing it changes; Phase 7 gives it a console and an organizer check.
   *
   * A room already open keeps playing: authorisation is asked live, so the new token works
   * immediately and the old one stops working everywhere at once.
   */
  private async relink(request: Request): Promise<Response> {
    const meta = this.meta()
    if (!meta) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    let body: { entrantId?: unknown; playerId?: unknown; displayName?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    const entrantId = typeof body.entrantId === 'string' ? body.entrantId : ''
    const row = this.sql
      .exec<Row>('SELECT * FROM entrants WHERE entrant_id = ?', entrantId)
      .toArray()[0]
    if (!row) return Response.json({ error: 'UNKNOWN_ENTRANT' }, { status: 404 })

    const token = mintEntrantToken()
    const playerId = typeof body.playerId === 'string' && body.playerId ? body.playerId : null
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim().slice(0, 40)
        : null

    this.sql.exec(
      `UPDATE entrants
          SET token_hash = ?,
              player_id = COALESCE(?, player_id),
              display_name = COALESCE(?, display_name)
        WHERE entrant_id = ?`,
      await hashToken(token),
      playerId,
      displayName,
      entrantId,
    )
    await this.touch()

    return Response.json({ ok: true, entrantId, entrantToken: token })
  }

  // --- Internals --------------------------------------------------------------------------------

  /**
   * The tournament row, or `null` if there is not one.
   *
   * **Tolerates the table being absent**, which is a real state rather than a defensive one: D42's
   * sweep calls `storage.deleteAll()` and takes the schema with it, and the instance stays alive
   * afterwards. A request arriving in that window found no `tournament` table and failed as a 500
   * — for a tournament that had simply expired, which is a 404. `alarm()` re-creates the empty
   * schema too; this is the belt to that pair of braces, and it is narrow on purpose: only a
   * missing table reads as "nothing here", and anything else still throws.
   */
  private meta(): TournamentRow | null {
    try {
      const row = this.sql.exec<Row>('SELECT * FROM tournament WHERE id = 1').toArray()[0]
      return row ? (row as unknown as TournamentRow) : null
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return null
      throw e
    }
  }

  /**
   * The bracket, rebuilt from the entrants and folded over the result log.
   *
   * `MANUAL` seeding on the rebuild, always: the seeds were decided once at creation and stored on
   * the rows. Re-running `RANDOM` here would be reproducible (the seed is stored too) but it would
   * mean the draw is re-derived rather than recorded, and a re-seeded tournament is not the same
   * tournament. Storing the outcome and replaying it as manual is the honest version.
   */
  private bracket(meta: { config: string; seeding_seed?: unknown }): BracketState {
    const config = JSON.parse(meta.config) as ResolvedTournamentConfig
    const entrants: Entrant[] = this.sql
      .exec<Row>('SELECT * FROM entrants ORDER BY seed')
      .toArray()
      .map((r) => ({
        entrantId: String(r['entrant_id']),
        playerId: String(r['player_id']),
        displayName: String(r['display_name']),
        seed: Number(r['seed']),
      }))

    const built = buildBracket(config.format, entrants, {
      seeding: 'MANUAL',
      grandFinalReset: config.grandFinalReset,
    })
    return rederive(built, this.results())
  }

  private results(): ResultEntry[] {
    return this.sql
      .exec<Row>('SELECT * FROM results ORDER BY seq')
      .toArray()
      .map((r): ResultEntry => {
        const slotId = String(r['slot_id'])
        const type = String(r['type'])
        /*
         * Every non-winning kind is listed, and the fallback throws.
         *
         * This was a `?:` with `DISPUTE` as the else, which silently turned a stored `DRAWN` row
         * back into a dispute — the bracket halted the right branch for the wrong stated reason,
         * and the only symptom was a word in the UI. A row this object wrote and cannot read is a
         * bug, not a state, so it fails loudly rather than picking a plausible neighbour.
         */
        switch (type) {
          case 'WIN':
            return { slotId, type: 'WIN', winner: String(r['winner']) }
          case 'DISPUTE':
            return { slotId, type: 'DISPUTE' }
          case 'VOID':
            return { slotId, type: 'VOID' }
          case 'DRAWN':
            return { slotId, type: 'DRAWN' }
          default:
            throw new Error(`unreadable result type '${type}' on slot '${slotId}'`)
        }
      })
  }

  private rooms(): Map<string, string> {
    const map = new Map<string, string>()
    for (const row of this.sql.exec<Row>('SELECT slot_id, room_code FROM provisioned').toArray()) {
      map.set(String(row['slot_id']), String(row['room_code']))
    }
    return map
  }

  /** Slots with both entrants known and no result — Phase 3 provisions matches from these. */
  ready(): string[] {
    const meta = this.meta()
    if (!meta) return []
    return readySlots(this.bracket(meta)).map((s) => s.id)
  }
}

/**
 * Validates the entrant list before a bracket is ever attempted.
 *
 * Names are required and trimmed to the same 40 characters `RegistryDO` uses, because these become
 * the captions on a bracket a dozen people look at. Ids are generated here rather than accepted
 * from the caller: an entrant id is this tournament's internal handle, and letting a client choose
 * it would invite collisions with nothing to gain.
 */
function parseEntrants(input: unknown): { entrants: Entrant[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'entrants must be an array' }
  if (input.length < MIN_ENTRANTS) return { error: `a tournament needs at least ${MIN_ENTRANTS}` }
  if (input.length > MAX_ENTRANTS) {
    return { error: `a tournament holds at most ${MAX_ENTRANTS} entrants (D42)` }
  }

  const entrants: Entrant[] = []
  const players = new Set<string>()

  for (const [i, raw] of input.entries()) {
    const e = raw as EntrantInput
    const playerId = typeof e?.playerId === 'string' ? e.playerId.trim() : ''
    const displayName = typeof e?.displayName === 'string' ? e.displayName.trim().slice(0, 40) : ''
    if (!playerId) return { error: `entrant ${i + 1} has no playerId` }
    if (!displayName) return { error: `entrant ${i + 1} has no displayName` }
    if (players.has(playerId)) {
      // D35 — the same person entered twice is almost always two browsers rather than a joke, and
      // either way a bracket cannot contain somebody twice.
      return { error: `playerId '${playerId}' is entered more than once` }
    }
    players.add(playerId)

    const seed = typeof e?.seed === 'number' ? e.seed : i + 1
    entrants.push({ entrantId: `t${i + 1}`, playerId, displayName, seed })
  }

  return { entrants }
}
