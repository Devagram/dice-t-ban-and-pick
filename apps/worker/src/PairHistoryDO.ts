/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers'

/**
 * **D28 — the only thing in this app that outlives a match.**
 *
 * One object per *pairing*, holding one fact: the last meta ban each of those two players brought
 * against the other. That is the entire feature, and keeping it that small is deliberate — D19
 * says there is no tournament layer, and the difference between "remember one ban" and "keep
 * player records" is a line worth being able to point at.
 *
 * What is **not** here, and should not arrive without a new decision: names, results, scores,
 * counts, timestamps used for anything but eviction, or history deeper than one set. If a feature
 * wants those, it wants a different object and a different argument.
 *
 * The name is `pairKey(a, b)` — the two ids sorted — so the same two people reach the same object
 * regardless of who hosted. Sorting is the whole of it: without it, "Tom vs Alex" and "Alex vs
 * Tom" would be two histories that each remembered half the story.
 */

export interface PairHistory {
  /** Last meta ban placed *by* each player id, against the other. */
  lastBanBy: Record<string, string>
}

const EMPTY: PairHistory = { lastBanBy: {} }

/**
 * Stable regardless of who hosts.
 *
 * Exported so `MatchDO` and the tests derive the name the same way; a second implementation of
 * this is a second chance to sort inconsistently.
 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

export class PairHistoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS last_ban (
           player_id TEXT PRIMARY KEY,
           character_id TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         )`,
      )
    })
  }

  override async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).pop()

    if (action === 'recent') return Response.json(this.read())

    if (action === 'record') {
      // Untrusted like every other body reaching this worker: it arrives from `MatchDO`, but a
      // malformed one must be a 400 rather than an unhandled throw. See the create endpoint.
      let body: { bans?: Record<string, string> }
      try {
        body = (await request.json()) as { bans?: Record<string, string> }
      } catch {
        return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
      }
      if (typeof body !== 'object' || body === null || typeof body.bans !== 'object') {
        return Response.json({ error: 'MALFORMED_BODY' }, { status: 400 })
      }
      this.write(body.bans ?? {})
      return Response.json({ ok: true })
    }

    return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  private read(): PairHistory {
    const rows = this.sql
      .exec<{ player_id: string; character_id: string }>(
        'SELECT player_id, character_id FROM last_ban',
      )
      .toArray()
    if (rows.length === 0) return EMPTY

    const lastBanBy: Record<string, string> = {}
    for (const row of rows) lastBanBy[row.player_id] = row.character_id
    return { lastBanBy }
  }

  /**
   * Overwrites rather than appends.
   *
   * The rule is "not two sets running", so only the most recent ban matters — a third set may
   * repeat the first set's ban, which is correct and is what the tests assert. Keeping a list
   * would make the rule quietly stricter over time.
   */
  private write(bans: Record<string, string>): void {
    const now = Date.now()
    for (const [playerId, characterId] of Object.entries(bans)) {
      if (typeof playerId !== 'string' || typeof characterId !== 'string') continue
      if (!playerId || !characterId) continue
      this.sql.exec(
        `INSERT INTO last_ban (player_id, character_id, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(player_id) DO UPDATE SET character_id = excluded.character_id,
                                                updated_at = excluded.updated_at`,
        playerId,
        characterId,
        now,
      )
    }
  }
}
