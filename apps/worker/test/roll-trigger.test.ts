/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EventEnvelope } from '@banpick/types'

import { commitAll, materialize, seatedMatch, type TestClient } from './client.js'

/**
 * The dice wait to be asked for.
 *
 * The outcome does not depend on the asking — it is fixed by `(seed, seq, actor, attempt)` before
 * either player clicks, and §11 keeps the DO the sole authority for all dice. What the gate buys
 * is the *moment*: the round used to throw them the instant it opened, which made the most
 * dramatic beat in a match something that happened at the players rather than between them.
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

/** Plays to the point where the first roll is offered, without taking it. */
async function atTheRoll() {
  const match = await seatedMatch({ modeId: 'base', draftCount: 4 })
  await commitAll(match.a, match.b)
  return match
}

const roll = (c: TestClient) => materialize(c.action('ROLL')!, c.seat)

describe('both seats have to ask', () => {
  it('offers the roll to each of them, and to nobody else', async () => {
    const { a, b } = await atTheRoll()
    expect(a.action('ROLL')).toBeTruthy()
    expect(b.action('ROLL')).toBeTruthy()
    expect(a.view.phase?.awaiting.sort()).toEqual(['A', 'B'])
  })

  it('does not roll on one', async () => {
    const { roomCode, a, b } = await atTheRoll()
    await a.act(roll(a))
    await b.settle(10)

    expect(a.view.rounds[0]?.roll).toBeNull()
    expect((await eventsOf(roomCode)).some((e) => e.payload.type === 'ROLL')).toBe(false)
    // And the board can say who it is still waiting for.
    expect(b.view.phase?.awaiting).toEqual(['B'])
  })

  it('rolls the moment the second one asks', async () => {
    const { a, b } = await atTheRoll()
    await a.act(roll(a))
    await b.act(roll(b))
    await a.settle(10)

    const landed = a.view.rounds[0]?.roll
    expect(landed).toBeTruthy()
    expect(landed!.throws.length).toBeGreaterThanOrEqual(1)
    expect(landed!.winner).toBeTruthy()
    // Both seats see the same dice — the roll is public (§7).
    expect(b.view.rounds[0]?.roll).toEqual(landed)
  })

  it('takes the roll off the table once it has landed', async () => {
    const { a, b } = await atTheRoll()
    await a.act(roll(a))
    await b.act(roll(b))
    await a.settle(10)
    expect(a.action('ROLL')).toBeUndefined()
  })
})

describe('the gate cannot be leaned on', () => {
  it('stops offering the roll to a seat that has already asked', async () => {
    const { a, b } = await atTheRoll()
    await a.act(roll(a))
    await b.settle(10)
    // Withdrawn from A, still open to B — `awaiting` and `legalActions` agree.
    expect(a.action('ROLL')).toBeUndefined()
    expect(b.action('ROLL')).toBeTruthy()
  })

  it('refuses a second ask from the same seat', async () => {
    // The payload is captured *before* the first ask, because the action is withdrawn once it
    // lands — this is a client replaying a stale frame, which is the case worth refusing. A
    // distinct key, so it is judged as a new action rather than deduped as a retry.
    const { a } = await atTheRoll()
    const stale = roll(a)
    await a.act(stale, 'first')
    await a.act(stale, 'second')
    expect(a.lastRejection?.code).toBe('DUPLICATE_COMMIT')
  })

  it('appends exactly one ROLL for one round, however the asks interleave', async () => {
    const { roomCode, a, b } = await atTheRoll()
    // Fired without awaiting between them: §11's single-threaded DO is what makes this safe.
    a.send({ type: 'ACTION', idempotencyKey: 'a-roll', payload: roll(a) })
    b.send({ type: 'ACTION', idempotencyKey: 'b-roll', payload: roll(b) })
    await a.settle(40)
    await b.settle(40)

    const events = await eventsOf(roomCode)
    expect(events.filter((e) => e.payload.type === 'ROLL')).toHaveLength(1)
    expect(events.filter((e) => e.payload.type === 'ROLL_READY')).toHaveLength(2)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  })

  it('keeps the dice the server’s — the ask carries no number', async () => {
    const { roomCode, a, b } = await atTheRoll()
    await a.act(roll(a))
    await b.act(roll(b))
    await a.settle(10)

    const ready = (await eventsOf(roomCode)).filter((e) => e.payload.type === 'ROLL_READY')
    for (const event of ready) {
      // §11 non-negotiable 1: a client that could name its own die could pick it.
      expect(JSON.stringify(event.payload)).not.toContain('results')
      expect(JSON.stringify(event.payload)).not.toContain('winner')
    }
    expect(ready.every((e) => e.actor === 'A' || e.actor === 'B')).toBe(true)
    // The roll itself is the system's.
    const rolled = (await eventsOf(roomCode)).find((e) => e.payload.type === 'ROLL')!
    expect(rolled.actor).toBe('SYSTEM')
  })
})
