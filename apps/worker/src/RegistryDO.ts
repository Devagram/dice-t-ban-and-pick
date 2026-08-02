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
  wins: number
  losses: number
  draws: number
}

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

  /** Counted from `matches` every time, so an undone result simply stops counting. */
  private standings(): Standing[] {
    const rows = this.sql
      .exec<{
        player_id: string
        name: string
        wins: number
        losses: number
        draws: number
      }>(
        `WITH sides AS (
           SELECT a_id AS player_id, a_name AS name, winner_id FROM matches
           UNION ALL
           SELECT b_id AS player_id, b_name AS name, winner_id FROM matches
         )
         SELECT player_id,
                MAX(name) AS name,
                SUM(CASE WHEN winner_id = player_id THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN winner_id IS NOT NULL AND winner_id != player_id THEN 1 ELSE 0 END)
                  AS losses,
                SUM(CASE WHEN winner_id IS NULL THEN 1 ELSE 0 END) AS draws
         FROM sides
         GROUP BY player_id`,
      )
      .toArray()

    return rows
      .map((r) => ({
        playerId: r.player_id,
        name: r.name,
        wins: Number(r.wins),
        losses: Number(r.losses),
        draws: Number(r.draws),
      }))
      .sort((x, y) => y.wins - x.wins || x.losses - y.losses || x.name.localeCompare(y.name))
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
}
