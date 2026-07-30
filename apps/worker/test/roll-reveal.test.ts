/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EventEnvelope } from '@banpick/types'

import { materialize, seatedMatch } from './client.js'

/**
 * The roll, as the client receives it.
 *
 * `DiceRoll` animates a roll that was already decided server-side; the only thing that makes the
 * animation possible is that the **per-attempt** record survives all the way to the browser.
 * The engine records it and `project` copies it, but neither of those is the property that
 * matters — this is, because a projection that quietly dropped `throws` would leave the client
 * unable to show a tie and nothing else would fail.
 *
 * The tie itself is not tested here: it is seeded, so whether one occurs depends on the seed the
 * DO happened to mint. `packages/engine/test/roll-tie.test.ts` covers the reroll rule directly,
 * on seeds searched for the purpose. What is tested here is the shape surviving the trip.
 */

const stub = (roomCode: string) => env.MATCH.get(env.MATCH.idFromName(roomCode))

async function rollEvents(roomCode: string): Promise<EventEnvelope[]> {
  return runInDurableObject(stub(roomCode), (_i, state) =>
    state.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq')
      .toArray()
      .map((r) => JSON.parse(r.payload) as EventEnvelope)
      .filter((e) => e.payload.type === 'ROLL'),
  )
}

/**
 * Plays to the first roll.
 *
 * `base` rather than `bring-ban1` on purpose: its program is `SIMULTANEOUS_COMMIT > ROLL`, so
 * both seats committing is enough. `bring-ban1` puts a recommit and two reveal gates in front of
 * its first roll (D10), which would make this a test of those gates instead.
 */
async function rolled(): Promise<Awaited<ReturnType<typeof seatedMatch>>> {
  const match = await seatedMatch({ modeId: 'base', draftCount: 4 })
  await match.a.act(materialize(match.a.action('COMMIT')!, 'A'))
  await match.b.act(materialize(match.b.action('COMMIT')!, 'B'))
  await match.a.settle(10)
  return match
}

describe('the roll arrives complete enough to animate', () => {
  it('projects every attempt to both seats', async () => {
    const { a, b } = await rolled()

    for (const client of [a, b]) {
      const roll = client.view.rounds[0]?.roll
      expect(roll, 'round 1 has no roll after both seats drafted').toBeTruthy()
      expect(Array.isArray(roll!.throws)).toBe(true)
      expect(roll!.throws.length).toBeGreaterThanOrEqual(1)
      expect(roll!.throws.length).toBe(roll!.attempts)
    }
  })

  it('agrees with the event log, so the animation cannot tell a different story', async () => {
    const { roomCode, a } = await rolled()

    const logged = rollPayload(await rollEvents(roomCode))
    expect(a.view.rounds[0]!.roll!.throws).toEqual(logged.throws)
    expect(a.view.rounds[0]!.roll!.winner).toBe(logged.winner)
  })

  it('ends on the throw that decided it', async () => {
    const { a } = await rolled()

    const roll = a.view.rounds[0]!.roll!
    const last = roll.throws.at(-1)!

    // The last throw is never a tie — a tie is precisely what forces another (`onTie: REROLL`).
    expect(last.A).not.toBe(last.B)
    // And it is the one the result reports, so the die that lands is the die that won.
    expect(last).toEqual(roll.results)
    expect(roll.winner).toBe(last.A > last.B ? 'A' : 'B')

    // Every throw before it must have been tied, or it would have ended sooner.
    for (const t of roll.throws.slice(0, -1)) expect(t.A).toBe(t.B)
  })

  it('both seats see identical dice', async () => {
    // The roll is public (§7): unlike a draft, there is nothing to hide, and a discrepancy here
    // would mean two players watching different animations of the same event.
    const { a, b } = await rolled()
    expect(a.view.rounds[0]!.roll).toEqual(b.view.rounds[0]!.roll)
  })
})

function rollPayload(events: EventEnvelope[]) {
  const first = events[0]
  expect(first, 'no ROLL event in the log').toBeTruthy()
  const payload = first!.payload
  if (payload.type !== 'ROLL') throw new Error('filtered event was not a ROLL')
  return payload
}
