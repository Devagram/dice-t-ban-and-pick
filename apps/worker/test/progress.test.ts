/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EventEnvelope } from '@banpick/types'

import { ids, seatedMatch } from './client.js'

/**
 * The progress relay.
 *
 * It exists because the server genuinely cannot know how far through a draft you are: a draft is
 * **one** `COMMIT` carrying every pick at once, so until it lands there is nothing to report.
 * The client therefore says so, and the DO passes it on.
 *
 * That makes it the one message in the protocol whose contents are neither authoritative nor
 * verifiable, which is exactly why these tests are about what it must **not** do: it must carry
 * no character, reach no log, and change no state. §7's seal is the thing at risk — a progress
 * ping that named a pick would defeat the entire hidden-commit mode.
 */

const stub = (roomCode: string) => env.MATCH.get(env.MATCH.idFromName(roomCode))

async function eventsOf(roomCode: string): Promise<EventEnvelope[]> {
  return runInDurableObject(stub(roomCode), (_i, state) =>
    state.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq')
      .toArray()
      .map((r) => JSON.parse(r.payload) as EventEnvelope),
  )
}

describe('progress reaches the opponent', () => {
  it('relays a count to the other seat, and not back to the sender', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    a.send({ type: 'PROGRESS', filled: 2, of: 5 })
    await b.settle(10)

    expect(b.progress.at(-1)).toEqual({
      type: 'OPPONENT_PROGRESS',
      seat: 'A',
      filled: 2,
      of: 5,
      // Counts describe *slots*; the meta ban rides alongside as its own flag, because "3 of 5"
      // cannot say whether that is three picks or two picks and a ban.
      ban: false,
    })
    // You already know your own progress; echoing it back is noise on the wire.
    expect(a.progress).toHaveLength(0)
  })

  it('attributes the seat from the socket, not from the message', async () => {
    const { a, b } = await seatedMatch()
    // There is no seat field to forge — but the relayed frame must still name the *sender*,
    // which is the property that would matter if one were ever added.
    a.send({ type: 'PROGRESS', filled: 1, of: 4 })
    await b.settle(10)
    expect(b.progress.at(-1)?.seat).toBe('A')
  })

  it('clamps nonsense instead of trusting or rejecting it', async () => {
    const { a, b } = await seatedMatch()

    a.send({ type: 'PROGRESS', filled: 999, of: 4 })
    await b.settle(10)
    expect(b.progress.at(-1)).toMatchObject({ filled: 4, of: 4 })

    a.send({ type: 'PROGRESS', filled: -5, of: 99999 })
    await b.settle(10)
    // Clamped rather than rejected: it decides nothing, so a bad count should cost a wrong
    // progress bar and not a round trip.
    const last = b.progress.at(-1)!
    expect(last.filled).toBeGreaterThanOrEqual(0)
    expect(last.of).toBeLessThanOrEqual(16)
    expect(last.filled).toBeLessThanOrEqual(last.of)
  })
})

describe('progress leaks nothing and changes nothing', () => {
  it('never appends an event', async () => {
    const { roomCode, a } = await seatedMatch()
    const before = (await eventsOf(roomCode)).length

    for (let i = 0; i <= 4; i++) a.send({ type: 'PROGRESS', filled: i, of: 4 })
    await a.settle(10)

    // Not game state, so not in the record of truth. A progress ping in the log would also
    // break replay determinism for no benefit whatsoever.
    expect((await eventsOf(roomCode)).length).toBe(before)
  })

  it('carries no character id, even while the sender holds real picks', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    const picks = await ids(0, 4)

    // A is mid-draft with real characters in mind. Its progress pings must describe *how many*,
    // never *which* — that is the whole content of the seal (§7).
    a.send({ type: 'PROGRESS', filled: 3, of: 5 })
    await b.settle(10)

    const frames = b.frames.filter((f) => f.includes('OPPONENT_PROGRESS'))
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      for (const id of picks) {
        expect(frame, `a progress frame leaked "${id}"`).not.toContain(id)
      }
    }
  })

  it('never costs a player the ability to act', async () => {
    // **The bug that took a live match down.** A client re-render loop turned the progress bar
    // into a flood; progress and actions shared one token bucket; the seat was rate-limited out
    // of its own COMMIT and the match was stuck on "too many actions; slow down".
    //
    // The client no longer chatters, but a *deployed* client still might, so this is the layer
    // that has to hold: whatever progress does, committing must still work.
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    for (let i = 0; i < 60; i++) a.send({ type: 'PROGRESS', filled: i % 5, of: 5 })
    await a.settle(60)

    const { materialize } = await import('./client.js')
    await a.act(materialize(a.action('COMMIT')!, 'A'))

    expect(a.lastError?.code, 'the flood locked the seat out of acting').not.toBe('RATE_LIMITED')
    expect(a.lastRejection).toBeUndefined()
    expect(b.view.opponent.hasCommitted).toBe(true)
  })

  it('does not disturb a match played alongside it', async () => {
    const { roomCode, a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    // Chatter interleaved with real actions: the log must be indistinguishable from a match
    // with no progress reporting at all.
    a.send({ type: 'PROGRESS', filled: 1, of: 5 })
    b.send({ type: 'PROGRESS', filled: 2, of: 5 })
    await a.settle(10)

    const { materialize } = await import('./client.js')
    await a.act(materialize(a.action('COMMIT')!, 'A'))
    a.send({ type: 'PROGRESS', filled: 5, of: 5 })
    await b.act(materialize(b.action('COMMIT')!, 'B'))

    const events = await eventsOf(roomCode)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    expect(events.every((e) => e.payload.type !== ('PROGRESS' as never))).toBe(true)
  })
})
