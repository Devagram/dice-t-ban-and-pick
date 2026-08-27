/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'

import { generateManualCode } from './identity.js'

/**
 * **D29 — names, results, and the standings derived from them.**
 *
 * One object for the whole deployment. That is right at this scale — §1's trust model is a group
 * of friends sharing a link — and the honest limit is that it serialises every write, which
 * matters at thousands of players and not at twelve. If it ever matters, the fix is to shard by
 * player and aggregate, and this comment is the warning that nobody did.
 *
 * **One store for results, not two.** The plan had head-to-head living in `PairHistoryDO` beside
 * the ban rule. It is here instead, because a head-to-head record and a global total computed
 * from two different tables are two things that can disagree — and the one that goes stale is
 * always the one nobody is looking at. Both are queries over the same `matches` table.
 * `PairHistoryDO` keeps doing exactly what D28 gave it, and its comment forbidding results stays
 * true.
 *
 * **D31 adds the open-room list.** Same object, because "which games are open right now" is the
 * same category of thing as the leaderboard — deployment-wide, outliving no single match — and a
 * second singleton would be a second thing to keep alive for no gain. It needs no migration: a
 * migration creates a Durable Object *class*, and this is a table on one that already exists.
 *
 * It is the one thing here that is *not* a record. Rooms are announced, updated, and swept; a
 * room nobody joined is noise within the hour, not history.
 *
 * **Totals are derived, never incremented.** D15 lets either seat undo the last result *including
 * on the final round*, which reopens a completed match — so a match can complete, un-complete,
 * and complete again with a different winner. Every write is an upsert keyed by room code, and
 * every total is a `COUNT` over what is stored. A counter would double-count that sequence and
 * nothing downstream would ever notice.
 */

export interface MatchRecord {
  roomCode: string
  playedAt: number
  /** Seat A and seat B, by generated id. Names are stored alongside for display. */
  a: { id: string; name: string }
  b: { id: string; name: string }
  /** The winning player id, or null for a draw. */
  winnerId: string | null
  scoreA: number
  scoreB: number
  /** What each seat drafted, played, and banned — enough to answer "what do they always play?" */
  detail: unknown
  /**
   * D37 — the tournament this match belonged to, if any.
   *
   * Absent for an ordinary game. Two jobs: history can distinguish a bracket match from a casual
   * one, and D39's refusal in `edit` needs something to refuse on — a tournament result must be
   * corrected from the tournament, so the bracket is re-derived with it.
   */
  tournamentId?: string
}

export interface Standing {
  playerId: string
  name: string
  /** Matches. */
  wins: number
  losses: number
  draws: number
  /** Individual rounds across those matches — a 2–1 win is two round wins and one round loss. */
  roundWins: number
  roundLosses: number
  roundDraws: number
}

/** D31 — one open or in-progress room, as the lobby list shows it. */
export interface RoomListing {
  roomCode: string
  modeLabel: string
  /** Empty until someone sits down and names themselves — a room predates its players. */
  hostName: string
  seatsTaken: number
  status: 'OPEN' | 'PLAYING'
  openedAt: number
}

/**
 * How long a room stays listed without anything happening to it.
 *
 * A host who opens a room and wanders off is the common case, not the exception, and a lobby
 * full of dead rooms is worse than an empty one — every entry is a click that goes nowhere.
 * Two hours is long enough to make a coffee and short enough that the list means something.
 * Measured from the last update, so a match in progress does not vanish underneath its players.
 *
 * **Deliberately not the same as `TOURNAMENT_TTL_MS`, which is seven days (D42).** They are two
 * different questions wearing one word: a listed room is an *invitation*, and a stale invitation
 * is worse than none. A tournament is a commitment that spans evenings. If these two numbers ever
 * look like an inconsistency worth tidying, read D42 before tidying it.
 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000

/** D34 — one pairing's record, for the history page's matchup table. */
export interface Matchup {
  a: { id: string; name: string }
  b: { id: string; name: string }
  /** Wins for `a`. Counted off one row per match, so the two directions cannot drift apart. */
  aWins: number
  bWins: number
  draws: number
  played: number
}

/** D37 Phase 8 — a tournament as the index lists it, and as it survives its own object. */
export interface TournamentSummary {
  code: string
  format: string
  /** Display names, so the list reads without a second lookup. Ids live on the matches. */
  entrants: string[]
  champion: string | null
  createdAt: number
  updatedAt: number
  complete: boolean
}

export interface HeadToHead {
  /** Wins for the first id given, losses for it, and draws. */
  wins: number
  losses: number
  draws: number
  matches: MatchRecord[]
}

/**
 * D35 — one identity, as the dashboard has to see it: the id included, not hidden behind a name.
 *
 * Everything downstream keys on `playerId`, and a name is only ever a caption on top of it. That
 * is invisible and fine right up until one person holds two ids — a second laptop, a cleared
 * browser, a private window (`player.ts` says so plainly: "a cleared browser is a new player") —
 * at which point the leaderboard shows them twice and no amount of renaming fixes it, because
 * renaming was never what split them.
 */
export interface PlayerSummary {
  playerId: string
  /** The name on this id's most recent match, or its claimed name if it has never finished one. */
  name: string
  /** Names this id owns in `names`. More than one only after a merge. */
  claimedNames: string[]
  played: number
  wins: number
  losses: number
  draws: number
  /** Both 0 for an id that claimed a name but never finished a match — a real and common state. */
  firstPlayedAt: number
  lastPlayedAt: number
}

export class RegistryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS names (
           name_key  TEXT PRIMARY KEY,
           name      TEXT NOT NULL,
           player_id TEXT NOT NULL,
           claimed_at INTEGER NOT NULL
         )`,
      )
      // D31 — the lobby list. `status` is 'OPEN' (a seat free) or 'PLAYING' (both taken, still
      // watchable). Finished rooms are deleted rather than marked: nothing lists them, and the
      // `matches` table above is where a finished game actually lives.
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS rooms (
           room_code   TEXT PRIMARY KEY,
           opened_at   INTEGER NOT NULL,
           updated_at  INTEGER NOT NULL,
           mode_label  TEXT NOT NULL,
           host_name   TEXT NOT NULL,
           seats_taken INTEGER NOT NULL,
           status      TEXT NOT NULL
         )`,
      )
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS matches (
           room_code TEXT PRIMARY KEY,
           played_at INTEGER NOT NULL,
           a_id TEXT NOT NULL, a_name TEXT NOT NULL,
           b_id TEXT NOT NULL, b_name TEXT NOT NULL,
           winner_id TEXT,
           score_a REAL NOT NULL,
           score_b REAL NOT NULL,
           detail TEXT NOT NULL
         )`,
      )
      /*
       * **D37 Phase 8 — where a tournament goes when its own object is gone.**
       *
       * `TournamentDO` is swept seven days after its last activity (D42), and that is right: a
       * bracket nobody has touched in a week is over. But "over" is exactly when the result starts
       * mattering, and a permanent page cannot be served by an object that has deleted itself.
       *
       * So a tournament files a summary here, beside the matches, and outlives the thing that
       * produced it.
       *
       * `view` holds the **final bracket**, and only once the tournament is finished. The first
       * draft of this table stored the summary alone, on the reasoning that the slot-by-slot
       * structure was derivable from the match rows — which is not true, and was worth writing
       * down rather than quietly fixing. Matches carry no slot ids and no edges, and a slot the
       * organizer resolved (a no-show, a void) produced no match at all. So the bracket is the one
       * thing here that genuinely cannot be reconstructed, and a page that has lost it is a list of
       * games rather than a tournament. Written only when complete, and cleared when a D39
       * correction makes a finished tournament unfinished again, so this can never serve a bracket
       * that has since moved.
       */
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS tournaments (
           code        TEXT PRIMARY KEY,
           format      TEXT NOT NULL,
           entrants    TEXT NOT NULL,
           champion    TEXT,
           created_at  INTEGER NOT NULL,
           updated_at  INTEGER NOT NULL,
           complete    INTEGER NOT NULL,
           view        TEXT
         )`,
      )
      /*
       * D37 — which tournament a match belonged to, if any.
       *
       * Added with `ALTER TABLE` rather than by editing the `CREATE` above: this object is already
       * deployed and holding rows, and a `CREATE TABLE IF NOT EXISTS` with a new column is a
       * no-op against an existing table — the column would simply never appear. Wrapped because
       * re-running it on a table that has it is an error, not a no-op.
       *
       * It earns its place twice: history can tell a tournament game from a casual one, and D39
       * needs it to refuse an `/admin` edit that would move a bracket's result behind its back.
       */
      try {
        this.sql.exec('ALTER TABLE matches ADD COLUMN tournament_id TEXT')
      } catch {
        // Already present.
      }
    })
  }

  override async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).pop()

    switch (action) {
      case 'claim':
        return this.claim(request)
      case 'record':
        return this.record(request)
      case 'standings':
        return Response.json({ standings: this.standings() })
      case 'room':
        return this.room(request)
      case 'rooms':
        return Response.json({ rooms: this.rooms() })
      case 'matches':
        return Response.json({ matches: this.matches(limitFrom(request)) })
      case 'matchups':
        return Response.json({ matchups: this.matchups() })
      case 'add':
        return this.add(request)
      case 'edit':
        return this.edit(request)
      case 'delete':
        return this.remove(request)
      case 'tournaments':
        return Response.json({ tournaments: this.tournaments() })
      case 'tournament':
        return this.recordTournament(request)
      case 'archive':
        return this.archive(request)
      case 'players':
        return Response.json({ players: this.players() })
      case 'merge':
        return this.merge(request)
      case 'head-to-head': {
        const url = new URL(request.url)
        const a = url.searchParams.get('a') ?? ''
        const b = url.searchParams.get('b') ?? ''
        return Response.json(this.headToHead(a, b))
      }
      default:
        return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    }
  }

  /**
   * First browser to use a name owns it.
   *
   * Case- and whitespace-insensitive, because "Tom" and "tom " being two players is exactly the
   * confusion a claimed name exists to prevent. Rebinding to the same id is a rename and is fine.
   */
  private async claim(request: Request): Promise<Response> {
    let body: { playerId?: unknown; displayName?: unknown }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    if (typeof body?.playerId !== 'string' || !body.playerId) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    const name = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : ''
    if (!name) return Response.json({ error: 'EMPTY_NAME' }, { status: 400 })
    const key = name.toLowerCase()

    const owner = this.sql
      .exec<{ player_id: string }>('SELECT player_id FROM names WHERE name_key = ?', key)
      .toArray()[0]?.player_id

    if (owner && owner !== body.playerId) {
      return Response.json({ error: 'NAME_TAKEN', name }, { status: 409 })
    }

    // A rename leaves the old name unclaimed rather than reserved — someone who renames to "Tom B"
    // should not keep "Tom" forever out of a group of four people.
    this.sql.exec('DELETE FROM names WHERE player_id = ? AND name_key != ?', body.playerId, key)
    this.sql.exec(
      `INSERT INTO names (name_key, name, player_id, claimed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, player_id = excluded.player_id`,
      key,
      name,
      body.playerId,
      Date.now(),
    )
    return Response.json({ ok: true, name })
  }

  /** Upsert by room code — see the note on undo at the top of this file. */
  private async record(request: Request): Promise<Response> {
    let match: MatchRecord
    try {
      match = (await request.json()) as MatchRecord
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    if (typeof match?.roomCode !== 'string' || !match.roomCode || !match.a?.id || !match.b?.id) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    this.sql.exec(
      `INSERT INTO matches
         (room_code, played_at, a_id, a_name, b_id, b_name, winner_id, score_a, score_b, detail,
          tournament_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_code) DO UPDATE SET
         played_at = excluded.played_at,
         winner_id = excluded.winner_id,
         score_a = excluded.score_a,
         score_b = excluded.score_b,
         detail = excluded.detail`,
      match.roomCode,
      match.playedAt || Date.now(),
      match.a.id,
      match.a.name ?? '',
      match.b.id,
      match.b.name ?? '',
      match.winnerId,
      match.scoreA ?? 0,
      match.scoreB ?? 0,
      JSON.stringify(match.detail ?? null),
      // D37 — null for an ordinary game, which is almost all of them.
      match.tournamentId ?? null,
    )
    return Response.json({ ok: true })
  }

  /**
   * Counted from `matches` every time, so an undone result simply stops counting.
   *
   * Aggregated in JavaScript rather than SQL because round results live inside each match's
   * `detail`. Extracting them in SQL would mean JSON functions or a second set of columns that
   * can drift from the record they summarise — and at this scale, reading every row is cheap.
   */
  private standings(): Standing[] {
    const rows = this.sql
      .exec<{
        a_id: string
        a_name: string
        b_id: string
        b_name: string
        winner_id: string | null
        detail: string
      }>('SELECT a_id, a_name, b_id, b_name, winner_id, detail FROM matches')
      .toArray()

    const table = new Map<string, Standing>()
    const seat = (id: string, name: string): Standing => {
      const existing = table.get(id)
      if (existing) {
        // Latest name wins, so renaming shows up rather than sticking at whatever was first.
        if (name) existing.name = name
        return existing
      }
      const fresh: Standing = {
        playerId: id,
        name,
        wins: 0,
        losses: 0,
        draws: 0,
        roundWins: 0,
        roundLosses: 0,
        roundDraws: 0,
      }
      table.set(id, fresh)
      return fresh
    }

    for (const row of rows) {
      const a = seat(row.a_id, row.a_name)
      const b = seat(row.b_id, row.b_name)

      if (row.winner_id === null) {
        a.draws++
        b.draws++
      } else if (row.winner_id === row.a_id) {
        a.wins++
        b.losses++
      } else {
        b.wins++
        a.losses++
      }

      // `rounds` is the per-round outcome as the engine recorded it: 'A', 'B', 'TIE', or null for
      // a round `stopWhenDecided` meant nobody played.
      let rounds: unknown
      try {
        rounds = (JSON.parse(row.detail) as { rounds?: unknown } | null)?.rounds ?? null
      } catch {
        rounds = null
      }
      if (!Array.isArray(rounds)) continue

      for (const outcome of rounds) {
        if (outcome === 'TIE') {
          a.roundDraws++
          b.roundDraws++
        } else if (outcome === 'A') {
          a.roundWins++
          b.roundLosses++
        } else if (outcome === 'B') {
          b.roundWins++
          a.roundLosses++
        }
        // null — a dead rubber nobody played. Not a result for either side.
      }
    }

    return [...table.values()].sort(
      (x, y) =>
        y.wins - x.wins ||
        x.losses - y.losses ||
        y.roundWins - x.roundWins ||
        x.name.localeCompare(y.name),
    )
  }

  /**
   * One record, read from either direction.
   *
   * `wins` is always "wins for `a`", so A's "3–2 up" and B's "2–3 down" are the same row read
   * twice rather than two rows that can drift apart.
   */
  private headToHead(a: string, b: string): HeadToHead {
    const rows = this.sql
      .exec<Record<string, string | number | null>>(
        `SELECT * FROM matches
          WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)
          ORDER BY played_at DESC`,
        a,
        b,
        b,
        a,
      )
      .toArray()

    let wins = 0
    let losses = 0
    let draws = 0
    const matches: MatchRecord[] = []

    for (const row of rows) {
      const winner = row['winner_id'] as string | null
      if (winner === null) draws++
      else if (winner === a) wins++
      else losses++

      matches.push({
        roomCode: String(row['room_code']),
        playedAt: Number(row['played_at']),
        a: { id: String(row['a_id']), name: String(row['a_name']) },
        b: { id: String(row['b_id']), name: String(row['b_name']) },
        winnerId: winner,
        scoreA: Number(row['score_a']),
        scoreB: Number(row['score_b']),
        detail: JSON.parse(String(row['detail'] ?? 'null')) as unknown,
      })
    }

    return { wins, losses, draws, matches }
  }

  /**
   * D31 — announce, update, or withdraw a room.
   *
   * One endpoint for all three because `MatchDO` calls it from three points in one lifecycle and
   * a room that is announced but never withdrawn is the failure this table has to avoid. An
   * upsert keyed by room code also makes it replay-safe: D15's undo can reopen a completed match,
   * and the room simply comes back.
   */
  private async room(request: Request): Promise<Response> {
    let body: {
      roomCode?: unknown
      modeLabel?: unknown
      hostName?: unknown
      seatsTaken?: unknown
      status?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    if (typeof body?.roomCode !== 'string' || !body.roomCode) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    if (body.status === 'CLOSED') {
      this.sql.exec('DELETE FROM rooms WHERE room_code = ?', body.roomCode)
      return Response.json({ ok: true })
    }

    const status = body.status === 'PLAYING' ? 'PLAYING' : 'OPEN'
    const now = Date.now()
    this.sql.exec(
      `INSERT INTO rooms (room_code, opened_at, updated_at, mode_label, host_name, seats_taken, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_code) DO UPDATE SET
         updated_at  = excluded.updated_at,
         mode_label  = excluded.mode_label,
         -- Kept once set: the host names themselves on sitting down, and a later update from a
         -- caller that does not know the name must not blank it out.
         host_name   = CASE WHEN excluded.host_name = '' THEN rooms.host_name
                            ELSE excluded.host_name END,
         seats_taken = excluded.seats_taken,
         status      = excluded.status`,
      body.roomCode,
      now,
      now,
      typeof body.modeLabel === 'string' ? body.modeLabel.slice(0, 60) : '',
      typeof body.hostName === 'string' ? body.hostName.slice(0, 40) : '',
      typeof body.seatsTaken === 'number' ? Math.max(0, Math.min(2, body.seatsTaken)) : 0,
      status,
    )
    return Response.json({ ok: true })
  }

  /** Swept on read rather than on a timer: the list is the only thing that cares. */
  private rooms(): RoomListing[] {
    this.sql.exec('DELETE FROM rooms WHERE updated_at < ?', Date.now() - ROOM_TTL_MS)
    return this.sql
      .exec<{
        room_code: string
        mode_label: string
        host_name: string
        seats_taken: number
        status: string
        opened_at: number
      }>(
        `SELECT room_code, mode_label, host_name, seats_taken, status, opened_at
           FROM rooms ORDER BY status = 'OPEN' DESC, opened_at DESC`,
      )
      .toArray()
      .map((r) => ({
        roomCode: r.room_code,
        modeLabel: r.mode_label,
        hostName: r.host_name,
        seatsTaken: r.seats_taken,
        status: r.status === 'PLAYING' ? ('PLAYING' as const) : ('OPEN' as const),
        openedAt: r.opened_at,
      }))
  }

  /**
   * D34 — every recorded match, newest first.
   *
   * The same rows the leaderboard is derived from, handed over whole rather than aggregated: the
   * history page wants exactly what a standings table throws away — which rounds went which way,
   * and what each seat brought.
   */
  private matches(limit: number): MatchRecord[] {
    return this.sql
      .exec<Record<string, string | number | null>>(
        'SELECT * FROM matches ORDER BY played_at DESC LIMIT ?',
        limit,
      )
      .toArray()
      .map(rowToRecord)
  }

  /**
   * Pairwise records, aggregated in JavaScript for the same reason `standings` is: counted off
   * the stored rows every time, so an edited or deleted match stops counting rather than leaving
   * a stale total behind.
   */
  private matchups(): Matchup[] {
    const table = new Map<string, Matchup>()

    const rows = this.sql
      .exec<{
        a_id: string
        a_name: string
        b_id: string
        b_name: string
        winner_id: string | null
      }>('SELECT a_id, a_name, b_id, b_name, winner_id FROM matches')
      .toArray()

    for (const row of rows) {
      // Keyed by the sorted pair, like D28's `pairKey`, so "Tom vs Alex" and "Alex vs Tom" are
      // one row read from either side rather than two that can disagree.
      const flip = row.b_id < row.a_id
      const first = flip ? { id: row.b_id, name: row.b_name } : { id: row.a_id, name: row.a_name }
      const second = flip ? { id: row.a_id, name: row.a_name } : { id: row.b_id, name: row.b_name }
      const key = `${first.id}|${second.id}`

      const entry = table.get(key) ?? {
        a: first,
        b: second,
        aWins: 0,
        bWins: 0,
        draws: 0,
        played: 0,
      }
      // Latest name wins, so a rename shows up rather than sticking at whatever was first.
      if (first.name) entry.a.name = first.name
      if (second.name) entry.b.name = second.name

      entry.played++
      if (row.winner_id === null) entry.draws++
      else if (row.winner_id === entry.a.id) entry.aWins++
      else entry.bWins++
      table.set(key, entry)
    }

    return [...table.values()].sort((x, y) => y.played - x.played)
  }

  /**
   * D35 — every id this deployment has ever seen, with the games attached to it.
   *
   * Derived rather than stored, like every other total here, and read from *both* tables: an id
   * that claimed a name but has not finished a match yet is exactly the one an admin is looking
   * for — it is what a returning player's new browser looks like ten seconds after they typed
   * their name into it and found it taken.
   */
  private players(): PlayerSummary[] {
    const table = new Map<string, PlayerSummary>()
    const entry = (id: string): PlayerSummary => {
      const existing = table.get(id)
      if (existing) return existing
      const fresh: PlayerSummary = {
        playerId: id,
        name: '',
        claimedNames: [],
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        firstPlayedAt: 0,
        lastPlayedAt: 0,
      }
      table.set(id, fresh)
      return fresh
    }

    // Oldest first, so "the last name written wins" is genuinely the most recent one used rather
    // than whatever order the rows happened to come back in — the bug `standings` still has.
    const rows = this.sql
      .exec<{
        a_id: string
        a_name: string
        b_id: string
        b_name: string
        winner_id: string | null
        played_at: number
      }>('SELECT a_id, a_name, b_id, b_name, winner_id, played_at FROM matches ORDER BY played_at')
      .toArray()

    for (const row of rows) {
      for (const side of [
        { id: row.a_id, name: row.a_name },
        { id: row.b_id, name: row.b_name },
      ]) {
        const player = entry(side.id)
        if (side.name) player.name = side.name
        player.played++
        if (row.winner_id === null) player.draws++
        else if (row.winner_id === side.id) player.wins++
        else player.losses++
        if (player.firstPlayedAt === 0) player.firstPlayedAt = row.played_at
        player.lastPlayedAt = Math.max(player.lastPlayedAt, row.played_at)
      }
    }

    for (const claim of this.sql
      .exec<{
        name: string
        player_id: string
      }>('SELECT name, player_id FROM names ORDER BY claimed_at')
      .toArray()) {
      const player = entry(claim.player_id)
      player.claimedNames.push(claim.name)
      // Only as a fallback: what they played under beats what they reserved, because the match
      // rows are what every other screen is showing.
      if (!player.name) player.name = claim.name
    }

    return [...table.values()].sort(
      (x, y) => y.lastPlayedAt - x.lastPlayedAt || x.name.localeCompare(y.name),
    )
  }

  /**
   * D35 — two ids that are one person.
   *
   * The counterpart to `edit`: that fixes what a match *says*, this fixes *whose* it was. A player
   * id is per-browser and there is no account behind it to reconcile against (`player.ts`, and
   * D19 settled that on purpose), so the duplicate is not a bug to prevent — it is the expected
   * cost of having no logins, and the only honest answer is a way to clean it up afterwards.
   *
   * **Refuses rather than guesses** when the two ids have faced each other. Those rows would
   * become a player against themselves, which `standings` counts as a win *and* a loss for one
   * person, and `matchups` keys as a pairing with itself. Whether such a match should be deleted
   * or reassigned to a third id is a judgement about what actually happened that evening, and
   * this endpoint does not have it — so it names the room codes and stops.
   */
  private async merge(request: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    const fromId = playerRef(body['fromId'])
    const intoId = playerRef(body['intoId'])
    if (!fromId || !intoId) {
      return Response.json(
        { error: 'MALFORMED_BODY', detail: 'merge needs both fromId and intoId' },
        { status: 400 },
      )
    }
    if (fromId === intoId) {
      return Response.json({ error: 'SAME_ID', detail: 'that is one id, not two' }, { status: 400 })
    }

    const collisions = this.sql
      .exec<{
        room_code: string
      }>(
        `SELECT room_code FROM matches
          WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)
          ORDER BY played_at DESC`,
        fromId,
        intoId,
        intoId,
        fromId,
      )
      .toArray()
      .map((r) => r.room_code)

    if (collisions.length > 0) {
      return Response.json(
        {
          error: 'SELF_MATCH',
          roomCodes: collisions,
          detail:
            `these two ids played each other in ${collisions.join(', ')} — ` +
            'delete or reassign those matches first, or the merge makes someone their own opponent',
        },
        { status: 409 },
      )
    }

    const counted = (sql: string, ...args: string[]): number =>
      Number(this.sql.exec<{ n: number }>(sql, ...args).toArray()[0]?.n ?? 0)

    const moved = counted(
      'SELECT COUNT(*) AS n FROM matches WHERE a_id = ? OR b_id = ?',
      fromId,
      fromId,
    )
    const names = counted('SELECT COUNT(*) AS n FROM names WHERE player_id = ?', fromId)

    this.sql.exec('UPDATE matches SET a_id = ? WHERE a_id = ?', intoId, fromId)
    this.sql.exec('UPDATE matches SET b_id = ? WHERE b_id = ?', intoId, fromId)
    // The winner is stored as an id, not as a seat letter, so it has to move too — otherwise a
    // merged player's wins land on nobody and the leaderboard quietly loses them.
    this.sql.exec('UPDATE matches SET winner_id = ? WHERE winner_id = ?', intoId, fromId)
    /*
     * Name claims move rather than being released. "First browser to use a name owns it" should
     * go on holding for the *person*, and freeing the old name would leave it available to a
     * stranger while it is still printed on the merged player's older matches.
     */
    this.sql.exec('UPDATE names SET player_id = ? WHERE player_id = ?', intoId, fromId)

    // Optional, and the reason it is here rather than in a second request: the merged rows still
    // carry whatever name each browser used, so without this the leaderboard shows one player
    // whose older games are captioned "Tom (laptop)".
    const rename = str(body['name'])
    if (rename) {
      this.sql.exec('UPDATE matches SET a_name = ? WHERE a_id = ?', rename, intoId)
      this.sql.exec('UPDATE matches SET b_name = ? WHERE b_id = ?', rename, intoId)
    }

    return Response.json({ ok: true, moved, names, players: this.players() })
  }

  /**
   * **D44 — a game that was played, but not here.**
   *
   * Every other row in this table is the residue of a match this deployment refereed: a room was
   * opened, both seats reported, and `record` filed what the log said. This one has no log behind
   * it at all. It is the evening somebody's laptop was flat, or the six games from before anyone
   * thought to open the site — history that exists and is simply not written down.
   *
   * So it sits beside `edit` rather than beside `record`, behind the same key and for the same
   * reason: D34 drew the line at *changing the stored record directly*, and inventing one is the
   * same power used a different way. `record` stays where it is, callable only by a match object
   * that watched the game happen.
   *
   * Two things it deliberately will not do:
   *
   * - **It never writes `tournament_id`.** A bracket's results belong to the bracket (D39), which
   *   derives itself from resolved slots; a hand-written row claiming to be a tournament match
   *   would be the second truth that decision exists to prevent. A tournament game that went
   *   unrecorded is fixed from the organizer console, not from here.
   * - **It stores no rosters.** `detail.seats` is what each side drafted, and nobody drafted
   *   anything — the history page already renders a match without them, and inventing an empty
   *   pair of rosters would make a game that was never drafted look like one that was.
   */
  private async add(request: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    const a = this.seatFor(body['aId'], body['aName'])
    const b = this.seatFor(body['bId'], body['bName'])
    if (!a || !b) {
      return Response.json(
        { error: 'MISSING_PLAYER', detail: 'each seat needs a player id, or a name to mint one' },
        { status: 400 },
      )
    }
    if (a.id === b.id) {
      return Response.json(
        { error: 'SELF_MATCH', detail: 'both seats are the same player' },
        { status: 409 },
      )
    }

    const roomCode = this.freeRecordCode()
    if (!roomCode) {
      return Response.json(
        { error: 'CODE_EXHAUSTED', detail: 'could not allocate a code for the record' },
        { status: 503 },
      )
    }

    const rounds = playedRounds(body['rounds'])
    const match: MatchRecord = {
      roomCode,
      // A backfilled game is usually an old one, and `played_at` is what the history sorts on —
      // so a date that lands it in the wrong week is the whole feature failing quietly. Absent
      // means now, which is right for "we just finished this off the app".
      playedAt: playedAt(body['playedAt']),
      a,
      b,
      // Absent is a draw rather than an error: `normalizeWinner` falls back to what is already on
      // the record, and on a record being created that is nothing. The dashboard always sends one.
      winnerId: null,
      scoreA: num(body['scoreA']) ?? 0,
      scoreB: num(body['scoreB']) ?? 0,
      detail: rounds ? { rounds } : null,
    }
    match.winnerId = normalizeWinner(body['winnerId'], match)

    this.sql.exec(
      `INSERT INTO matches
         (room_code, played_at, a_id, a_name, b_id, b_name, winner_id, score_a, score_b, detail,
          tournament_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      match.roomCode,
      match.playedAt,
      match.a.id,
      match.a.name,
      match.b.id,
      match.b.name,
      match.winnerId,
      match.scoreA,
      match.scoreB,
      JSON.stringify(match.detail),
    )
    return Response.json({ ok: true, match })
  }

  /**
   * One seat of a hand-added match: an existing id, or a name with a fresh id minted for it.
   *
   * The second half is the part worth defending. A player id comes from a browser (D35), so
   * somebody who has never opened the site has no id to attribute a game to — and the group this
   * app is for contains exactly that person. Refusing would make the feature useless for the
   * evening it exists to record; typing a name into a text field and calling it a player would
   * make the leaderboard a fiction.
   *
   * So a name with no id gets an id, and it is a real one: it counts, it can be reassigned, and
   * when that person does open the site D35's merge folds the two together. That is the same
   * repair path a second laptop already uses, which is the argument for minting here rather than
   * inventing a second kind of player that only the admin screen understands.
   *
   * An id that was given wins over a name that was not: `names` is where a claimed name lives, and
   * a caller who sent an id and no name means "whoever that is", not "nobody".
   */
  private seatFor(id: unknown, name: unknown): { id: string; name: string } | null {
    const known = playerRef(id)
    const label = str(name)
    if (!known && !label) return null
    const playerId = known ?? `p_${crypto.randomUUID()}`
    return { id: playerId, name: label ?? this.claimedName(playerId) }
  }

  /** The name this id claimed, if it ever claimed one. Empty is an ordinary answer. */
  private claimedName(playerId: string): string {
    const row = this.sql
      .exec<{
        name: string
      }>('SELECT name FROM names WHERE player_id = ? ORDER BY claimed_at LIMIT 1', playerId)
      .toArray()[0]
    return row?.name ?? ''
  }

  /**
   * A record code nothing else holds, or `null`.
   *
   * Checked rather than upserted, unlike every other write here. `record` upserts because a match
   * that completes twice is one match; two hand-added games are two games, and collapsing them
   * onto a collision would delete one without saying so. The registry can see the whole table, so
   * it can simply look — the retry loop covers the birthday case rather than a real shortage.
   */
  private freeRecordCode(): string | null {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateManualCode()
      const taken = this.sql
        .exec('SELECT room_code FROM matches WHERE room_code = ?', code)
        .toArray()
      if (taken.length === 0) return code
    }
    return null
  }

  /**
   * D34 — an admin correction to a stored match.
   *
   * **This edits the record, not the log**, and the difference is the reason it sits behind a key
   * while D33's amendment does not. D33 changes the event log and lets the record follow, so the
   * two keep agreeing. This cannot: a match whose room has expired has no log left to amend, and
   * the record is all that survives. So an edit here can leave the stored result saying something
   * the log never said. That is the price of being able to fix a game from last month.
   *
   * Partial by design — only the fields present are touched, so correcting a name cannot quietly
   * reset a score.
   *
   * D35 adds `aId`/`bId`: reassigning a single match to a different player, for the case a merge
   * is too broad for — one game played on a borrowed laptop, rather than an id that is wrong
   * everywhere.
   */
  private async edit(request: Request): Promise<Response> {
    let body: Record<string, unknown>
    try {
      body = (await request.json()) as Record<string, unknown>
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    const roomCode = typeof body['roomCode'] === 'string' ? body['roomCode'] : ''
    if (!roomCode) return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })

    const existing = this.sql
      .exec<Record<string, string | number | null>>(
        'SELECT * FROM matches WHERE room_code = ?',
        roomCode,
      )
      .toArray()[0]
    if (!existing) return Response.json({ error: 'NOT_FOUND' }, { status: 404 })

    /*
     * **D39 — a tournament match is not editable from here.**
     *
     * Changing the winner in this table would move the leaderboard and leave the bracket saying
     * something else — two truths, and the stale one is always the one nobody is looking at. The
     * organizer console re-derives the bracket from a corrected result log, which is the only
     * path that keeps both in step, so this one points at it rather than half-doing the job.
     */
    if (existing['tournament_id']) {
      return Response.json(
        {
          error: 'TOURNAMENT_MATCH',
          detail:
            `'${roomCode}' belongs to tournament ${String(existing['tournament_id'])}. ` +
            'Correct it from the tournament, so the bracket is re-derived with it.',
        },
        { status: 409 },
      )
    }

    const record = rowToRecord(existing)
    const seats = {
      a: { id: playerRef(body['aId']) ?? record.a.id, name: str(body['aName']) ?? record.a.name },
      b: { id: playerRef(body['bId']) ?? record.b.id, name: str(body['bName']) ?? record.b.name },
    }
    if (seats.a.id === seats.b.id) {
      return Response.json(
        { error: 'SELF_MATCH', detail: 'both seats would be the same player' },
        { status: 409 },
      )
    }

    const next: MatchRecord = {
      ...record,
      ...seats,
      /*
       * `winnerId` is nullable, so absent and null are different answers and `??` would conflate
       * them — a draw has to be settable, not just unsettable.
       */
      winnerId:
        'winnerId' in body
          ? normalizeWinner(body['winnerId'], { ...record, ...seats })
          : followSeat(record.winnerId, record, seats),
      scoreA: num(body['scoreA']) ?? record.scoreA,
      scoreB: num(body['scoreB']) ?? record.scoreB,
      detail: 'rounds' in body ? withRounds(record.detail, body['rounds']) : record.detail,
    }

    this.sql.exec(
      `UPDATE matches SET a_id = ?, a_name = ?, b_id = ?, b_name = ?, winner_id = ?,
         score_a = ?, score_b = ?, detail = ? WHERE room_code = ?`,
      next.a.id,
      next.a.name,
      next.b.id,
      next.b.name,
      next.winnerId,
      next.scoreA,
      next.scoreB,
      JSON.stringify(next.detail ?? null),
      roomCode,
    )
    return Response.json({ ok: true, match: next })
  }

  /**
   * D37 Phase 8 — a tournament files itself here, and stays after its own object is swept.
   *
   * Upserted by code and safe to call repeatedly, for the same reason `record` is: a tournament
   * announces itself when it starts and again whenever it finishes, and D39's correction can make
   * a finished one unfinished. The last write wins and describes the bracket as it now stands.
   */
  private async recordTournament(request: Request): Promise<Response> {
    let body: {
      code?: unknown
      format?: unknown
      entrants?: unknown
      champion?: unknown
      createdAt?: unknown
      complete?: unknown
      view?: unknown
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    if (typeof body.code !== 'string' || !body.code) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }

    const now = Date.now()
    this.sql.exec(
      `INSERT INTO tournaments
         (code, format, entrants, champion, created_at, updated_at, complete, view)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         format = excluded.format,
         entrants = excluded.entrants,
         champion = excluded.champion,
         updated_at = excluded.updated_at,
         complete = excluded.complete,
         view = excluded.view`,
      body.code,
      typeof body.format === 'string' ? body.format : 'SINGLE_ELIMINATION',
      JSON.stringify(Array.isArray(body.entrants) ? body.entrants : []),
      typeof body.champion === 'string' ? body.champion : null,
      typeof body.createdAt === 'number' ? body.createdAt : now,
      now,
      body.complete === true ? 1 : 0,
      // Overwritten every time, `null` included: an unfinished tournament must not leave an older
      // finished bracket lying here for the archive to serve.
      body.view && typeof body.view === 'object' ? JSON.stringify(body.view) : null,
    )
    return Response.json({ ok: true })
  }

  /**
   * The final bracket of a finished tournament, once its own object is gone.
   *
   * Answers 404 for a code nobody has heard of *and* for one whose tournament is still running —
   * in the second case the live object is the answer, and serving a copy from here would be the
   * one bracket on the page that cannot update.
   */
  private archive(request: Request): Response {
    const code = new URL(request.url).searchParams.get('code') ?? ''
    const row = this.sql.exec<Row>('SELECT view FROM tournaments WHERE code = ?', code).toArray()[0]
    const view = row?.['view']
    if (typeof view !== 'string') return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    return Response.json({ view: JSON.parse(view) as unknown })
  }

  /** Every tournament this deployment has seen, newest first. Public, like the history. */
  private tournaments(): TournamentSummary[] {
    return this.sql
      .exec<Row>('SELECT * FROM tournaments ORDER BY created_at DESC LIMIT 200')
      .toArray()
      .map((row) => ({
        code: String(row['code']),
        format: String(row['format']),
        entrants: JSON.parse(String(row['entrants'] ?? '[]')) as string[],
        champion: (row['champion'] as string | null) ?? null,
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        complete: Number(row['complete']) === 1,
      }))
  }

  /** Removing a junk record, which is otherwise permanent — see the note on `edit`. */
  private async remove(request: Request): Promise<Response> {
    let body: { roomCode?: unknown }
    try {
      body = (await request.json()) as { roomCode?: unknown }
    } catch {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    if (typeof body?.roomCode !== 'string' || !body.roomCode) {
      return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
    }
    this.sql.exec('DELETE FROM matches WHERE room_code = ?', body.roomCode)
    return Response.json({ ok: true })
  }
}

/** The shape `sql.exec` hands back. Declared once rather than inline at every call site. */
type Row = Record<string, string | number | null>

function limitFrom(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get('limit'))
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 200
}

function rowToRecord(row: Record<string, string | number | null>): MatchRecord {
  return {
    roomCode: String(row['room_code']),
    playedAt: Number(row['played_at']),
    a: { id: String(row['a_id']), name: String(row['a_name']) },
    b: { id: String(row['b_id']), name: String(row['b_name']) },
    winnerId: (row['winner_id'] as string | null) ?? null,
    scoreA: Number(row['score_a']),
    scoreB: Number(row['score_b']),
    detail: JSON.parse(String(row['detail'] ?? 'null')) as unknown,
    /*
     * D37 — written since Phase 4 and read back since Phase 8.
     *
     * It was stored and never returned, which meant the column did its job for D39's admin refusal
     * and none of the job it was also added for: history could not tell a bracket match from a
     * casual one. A field that is written and never read is indistinguishable from one nobody
     * needed.
     */
    ...(row['tournament_id'] ? { tournamentId: String(row['tournament_id']) } : {}),
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.trim().slice(0, 40) : undefined

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * A player id, which is not a name and must not be capped like one — `p_` plus a UUID is already
 * 38 of `str`'s 40 characters, and an id silently truncated is an id that matches nothing.
 */
const playerRef = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim().slice(0, 128)
  return trimmed ? trimmed : undefined
}

/**
 * A reassigned seat takes its result with it.
 *
 * The winner is stored as a player id rather than a seat letter, so moving a match to a different
 * player without this leaves `winner_id` pointing at someone who is no longer in the match — which
 * `standings` reads as "neither seat won" and silently scores as a loss for the winner.
 */
function followSeat(
  winnerId: string | null,
  was: MatchRecord,
  now: { a: { id: string }; b: { id: string } },
): string | null {
  if (winnerId === null) return null
  if (winnerId === was.a.id) return now.a.id
  if (winnerId === was.b.id) return now.b.id
  return winnerId
}

/** Accepts a seat letter, a player id, or null — the dashboard speaks seats, storage speaks ids. */
function normalizeWinner(value: unknown, record: MatchRecord): string | null {
  if (value === null || value === '' || value === 'DRAW') return null
  if (value === 'A') return record.a.id
  if (value === 'B') return record.b.id
  return typeof value === 'string' ? value : record.winnerId
}

/** Replaces only the round results, leaving the drafted/played detail beside them untouched. */
function withRounds(detail: unknown, rounds: unknown): unknown {
  const base = (detail ?? {}) as Record<string, unknown>
  if (!Array.isArray(rounds)) return detail
  return { ...base, rounds: rounds.map((r) => (r === 'A' || r === 'B' || r === 'TIE' ? r : null)) }
}

/**
 * D44 — the round results of a hand-added match, or `null` if nobody says how it went.
 *
 * Trailing unplayed rounds are dropped rather than stored. `stopWhenDecided` means a real 2–0 Bo3
 * stores `['A', 'A', null]` and the history renders that third `—` as "not played" — true of a
 * game that ended early, and misleading on a record whose owner simply did not fill the row in.
 * An array with nothing in it at all becomes no `detail`, which is the shape the history already
 * handles: a result with no round-by-round behind it.
 */
function playedRounds(value: unknown): (('A' | 'B' | 'TIE') | null)[] | null {
  if (!Array.isArray(value)) return null
  const rounds = value.map((r) => (r === 'A' || r === 'B' || r === 'TIE' ? r : null))
  while (rounds.length > 0 && rounds[rounds.length - 1] === null) rounds.pop()
  return rounds.length > 0 ? rounds : null
}

/**
 * When a hand-added match was played. Absent, or nonsense, means now.
 *
 * The history sorts on this and renders it as "3d ago", so a zero or a negative from a date field
 * that failed to parse would file the game in 1970 and bury it under everything.
 */
function playedAt(value: unknown): number {
  const at = num(value)
  return at !== undefined && at > 0 ? Math.floor(at) : Date.now()
}
