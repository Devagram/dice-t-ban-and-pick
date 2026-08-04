/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'

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
 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000

export interface HeadToHead {
  /** Wins for the first id given, losses for it, and draws. */
  wins: number
  losses: number
  draws: number
  matches: MatchRecord[]
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
         (room_code, played_at, a_id, a_name, b_id, b_name, winner_id, score_a, score_b, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
}
