/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EventEnvelope } from '@banpick/types'

import { tryAppendEvent } from '../src/persistence.js'
import { materialize, playToCompletion, seatedMatch } from './client.js'

/**
 * The append guard.
 *
 * §11's concurrency guarantee comes from a Durable Object being single-threaded, and Phase 3
 * tests that it holds. This file tests the *other* guarantee — the one in the data model — which
 * exists because the first one lives in the runtime, and a guarantee that lives in the runtime
 * is one a future deployment decision can silently remove.
 *
 * A genuine race cannot be created inside a DO, which is the whole point of a DO. So the
 * conflict is created directly: write the `seq` first, then ask the guard what it does.
 */

const stub = (roomCode: string) => env.MATCH.get(env.MATCH.idFromName(roomCode))

function fakeEvent(seq: number): EventEnvelope {
  return {
    v: 1,
    seq,
    tag: 'intruder',
    actor: 'SYSTEM',
    payload: { type: 'SEAT_FILLED', seat: 'A' },
  }
}

describe('seq is the concurrency key', () => {
  it('accepts the first writer for a seq and refuses the second', async () => {
    const { roomCode } = await seatedMatch()

    await runInDurableObject(stub(roomCode), (_i, state) => {
      const sql = state.storage.sql
      const next = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one().n

      // First writer wins.
      expect(tryAppendEvent(sql, fakeEvent(next))).toBe(true)
      // Second writer for the same seq loses — and reports it rather than throwing, so the
      // caller can re-read and re-judge instead of the request dying.
      expect(tryAppendEvent(sql, fakeEvent(next))).toBe(false)
      // And exactly one row exists for it.
      const count = sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE seq = ?', next)
        .one().n
      expect(count).toBe(1)
    })
  })

  it('leaves the winner’s payload untouched — a loser never overwrites', async () => {
    const { roomCode } = await seatedMatch()

    await runInDurableObject(stub(roomCode), (_i, state) => {
      const sql = state.storage.sql
      const next = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events').one().n

      const winner = { ...fakeEvent(next), tag: 'winner' }
      const loser = { ...fakeEvent(next), tag: 'loser' }

      expect(tryAppendEvent(sql, winner)).toBe(true)
      expect(tryAppendEvent(sql, loser)).toBe(false)

      const stored = JSON.parse(
        sql.exec<{ payload: string }>('SELECT payload FROM events WHERE seq = ?', next).one()
          .payload,
      ) as EventEnvelope
      // An `INSERT OR REPLACE` here would silently rewrite history, which in an event-sourced
      // system is the one thing that must never happen.
      expect(stored.tag).toBe('winner')
    })
  })

  it('does not disturb the ordinary path — the log stays dense through a whole match', async () => {
    const { roomCode, a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'B', 'A'])

    const seqs = await runInDurableObject(stub(roomCode), (_i, state) =>
      state.storage.sql
        .exec<{ seq: number }>('SELECT seq FROM events ORDER BY seq')
        .toArray()
        .map((r) => r.seq),
    )

    expect(seqs).toEqual(seqs.map((_, i) => i))
    expect(a.view.status).toBe('COMPLETE')
  })

  it('still refuses a second seat claim once both are taken', async () => {
    // The claim path now decides on the append rather than on the read, so this is the same
    // 409 by a different route.
    const { roomCode } = await seatedMatch()
    const third = await env.MATCH.get(env.MATCH.idFromName(roomCode))
    const response = await third.fetch('https://example.com/seat', { method: 'POST' })
    expect(response.status).toBe(409)
  })

  it('keeps a concurrent commit pair to exactly one reveal', async () => {
    // The Phase 3 assertion, re-run against the guarded path: the retry loop must not turn one
    // reveal into two by re-appending after a conflict.
    const { roomCode, a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    a.send({ type: 'ACTION', idempotencyKey: 'a1', payload: materialize(a.action('COMMIT')!, 'A') })
    b.send({ type: 'ACTION', idempotencyKey: 'b1', payload: materialize(b.action('COMMIT')!, 'B') })
    await a.settle(40)
    await b.settle(40)

    // Matched on the event's `tag`, not on a substring of the payload: MATCH_CREATED carries
    // the resolved mode, whose `revealTags` contain the literal string "draft:reveal", so a
    // LIKE would count the creation event as a reveal.
    const reveals = await runInDurableObject(
      stub(roomCode),
      (_i, state) =>
        state.storage.sql
          .exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq')
          .toArray()
          .map((r) => JSON.parse(r.payload) as EventEnvelope)
          .filter((e) => e.tag === 'draft:reveal').length,
    )
    expect(reveals).toBe(1)
  })
})
