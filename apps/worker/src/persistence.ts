/// <reference types="@cloudflare/workers-types" />

import type { EventEnvelope, Seat } from '@banpick/types'

/**
 * SQLite persistence for one match.
 *
 * **The event log is the record of truth and the projection is derived** (D9). Nothing here
 * stores a `MatchState`: state is a fold over the log, so persisting it would create a second
 * source of truth that can disagree with the first — and the one that disagrees silently is
 * always the cached one.
 *
 * §11's free-plan table budgets tens of row-writes per match against a 100,000/day limit.
 */

export interface StoredSeat {
  seat: Seat
  tokenHash: string
  claimedAt: number
}

export function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seats (
      seat       TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    );

    -- Idempotency (Phase 3 deliverable). A double-clicked commit must not append twice, and
    -- the seal makes that unfixable afterwards: a committed action cannot be withdrawn (§12).
    CREATE TABLE IF NOT EXISTS applied_actions (
      key      TEXT PRIMARY KEY,
      seat     TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      code     TEXT,
      detail   TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

// --- Events ------------------------------------------------------------------------------------

/**
 * Appends an event, **or reports that someone else already claimed that `seq`.**
 *
 * `seq` is `INTEGER PRIMARY KEY`, so the log's own sequence number is the concurrency key: two
 * writers who both read a log of length N will both try to write `seq = N`, and exactly one can
 * win. That is the whole guard.
 *
 * Under Durable Objects this can never fire — §11's single-threaded execution is what makes
 * simultaneous ready-clicks safe, and Phase 3 tests that. It exists because that guarantee
 * currently lives in the *runtime*, and a guarantee that lives in the runtime is one that a
 * future deployment decision can silently remove. Here it lives in the data model instead, so
 * the design is safe on any host that can run two processes — which is every host except this
 * one.
 *
 * Written as a conditional insert rather than a caught exception on purpose: detecting a unique
 * violation means matching on a driver's error text, which is exactly the kind of thing that
 * works until a version bump.
 */
export function tryAppendEvent(sql: SqlStorage, event: EventEnvelope): boolean {
  const cursor = sql.exec(
    'INSERT INTO events (seq, payload) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM events WHERE seq = ?)',
    event.seq,
    JSON.stringify(event),
    event.seq,
  )
  return cursor.rowsWritten > 0
}

export function loadEvents(sql: SqlStorage): EventEnvelope[] {
  const rows = sql.exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq').toArray()
  return rows.map((r) => JSON.parse(r.payload) as EventEnvelope)
}

export function eventCount(sql: SqlStorage): number {
  const row = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one()
  return row.n
}

// --- Seats -------------------------------------------------------------------------------------

/**
 * Only the **hash** of a seat token is stored.
 *
 * The token is a bearer credential (D17): whoever holds it holds the seat, hidden commits
 * included. Storing it in the clear would mean a dump of the DO's SQLite is a dump of every
 * live seat, and there is no reason to accept that when a comparison against a hash works
 * exactly as well.
 */
export function claimSeat(sql: SqlStorage, seat: Seat, tokenHash: string, at: number): void {
  sql.exec('INSERT INTO seats (seat, token_hash, claimed_at) VALUES (?, ?, ?)', seat, tokenHash, at)
}

export function seatForTokenHash(sql: SqlStorage, tokenHash: string): Seat | null {
  const rows = sql
    .exec<{ seat: string }>('SELECT seat FROM seats WHERE token_hash = ?', tokenHash)
    .toArray()
  return (rows[0]?.seat as Seat | undefined) ?? null
}

export function claimedSeats(sql: SqlStorage): Seat[] {
  return sql
    .exec<{ seat: string }>('SELECT seat FROM seats ORDER BY seat')
    .toArray()
    .map((r) => r.seat as Seat)
}

// --- Idempotency -------------------------------------------------------------------------------

export interface AppliedAction {
  accepted: boolean
  code: string | null
  detail: string | null
}

export function recallAction(sql: SqlStorage, key: string): AppliedAction | null {
  const rows = sql
    .exec<{ accepted: number; code: string | null; detail: string | null }>(
      'SELECT accepted, code, detail FROM applied_actions WHERE key = ?',
      key,
    )
    .toArray()
  const row = rows[0]
  return row ? { accepted: row.accepted === 1, code: row.code, detail: row.detail } : null
}

export function rememberAction(
  sql: SqlStorage,
  key: string,
  seat: Seat,
  result: AppliedAction,
): void {
  sql.exec(
    'INSERT OR REPLACE INTO applied_actions (key, seat, accepted, code, detail) VALUES (?, ?, ?, ?, ?)',
    key,
    seat,
    result.accepted ? 1 : 0,
    result.code,
    result.detail,
  )
}

// --- Meta --------------------------------------------------------------------------------------

export function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value)
}

export function getMeta(sql: SqlStorage, key: string): string | null {
  const rows = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()
  return rows[0]?.value ?? null
}
