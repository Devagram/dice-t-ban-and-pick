/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject } from 'cloudflare:test'
import type { EventEnvelope } from '@banpick/types'

import { ids, materialize, playToCompletion, seatedMatch } from './client.js'
import type { TestClient } from './client.js'

/**
 * The properties §11 says the Durable Object exists to provide.
 *
 * "One Durable Object per match. Single-threaded execution means simultaneous ready-clicks
 * cannot interleave, and the DO is the authority for all dice and all legality."
 *
 * Two of the exit criteria are here and are deliberately not written as "trust the runtime":
 * the concurrent-reveal test **forces** concurrency rather than assuming serialization, and the
 * redaction test asserts on the **real frame off the wire** rather than an object a `toJSON`
 * might yet betray.
 */

async function eventsOf(roomCode: string): Promise<EventEnvelope[]> {
  const stub = env.MATCH.get(env.MATCH.idFromName(roomCode))
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq')
      .toArray()
      .map((r) => JSON.parse(r.payload) as EventEnvelope),
  )
}

describe('simultaneous commits produce one reveal, not two', () => {
  it('serializes two commits fired without awaiting between them', async () => {
    const { roomCode, a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    const aCommit = materialize(a.action('COMMIT')!, 'A')
    const bCommit = materialize(b.action('COMMIT')!, 'B')

    // Forced concurrency: both frames go out before either is processed. This is the case
    // §11's single-threaded claim is about, and the test would be worthless if it awaited the
    // first commit before sending the second.
    a.send({ type: 'ACTION', idempotencyKey: 'a-commit', payload: aCommit })
    b.send({ type: 'ACTION', idempotencyKey: 'b-commit', payload: bCommit })

    await a.settle(40)
    await b.settle(40)

    const events = await eventsOf(roomCode)

    // Exactly one commit each, and exactly one gate-one reveal. Two reveals would mean both
    // seats read a pre-commit state and both concluded they were the second to arrive.
    expect(events.filter((e) => e.payload.type === 'COMMIT')).toHaveLength(2)
    expect(events.filter((e) => e.tag === 'draft:reveal')).toHaveLength(1)

    // And the log is a clean sequence with no gaps or repeats.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
  })

  it('keeps the sequence dense across a whole concurrent match', async () => {
    const { roomCode, a, b } = await seatedMatch()
    await playToCompletion(a, b, ['A', 'B', 'A'])

    const events = await eventsOf(roomCode)
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i))
    // Every event is authored by a seat or by SYSTEM, and every SYSTEM event is one the engine
    // asked for — nothing in the DO invents game state.
    for (const event of events) expect(['A', 'B', 'SYSTEM']).toContain(event.actor)
  })
})

describe('redaction, asserted on the real frame off the wire (§7)', () => {
  it("A's frames never contain B's picks before gate two", async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    // Disjoint drafts, taken from the live roster rather than hardcoded. Letting both seats take
    // the first legal option would make the two sides identical, and then B's *ban* — public at
    // gate one — would coincide with one of B's *picks*, so the leak detector would fire on
    // something that is legitimately visible.
    const aPicks = await ids(0, 4)
    const bPicks = await ids(4, 4)
    const missesA = (await ids(8, 1))[0]!

    await a.act({
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks: aPicks,
      metaBan: bPicks[0]!, // hits B, so the repick holds gate two open
    })
    await b.act({
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'B',
      picks: bPicks,
      metaBan: missesA,
    })

    const bBan = b.view.you.metaBanPlaced!
    expect('slots' in a.view.opponent).toBe(false) // gate two has not fired

    // §7 warns that "an object test passes while a `toJSON` leaks", so this searches the actual
    // serialized frames. It searches the *sealed region* rather than the whole frame, because
    // the frame legitimately carries the public roster and A's own draft pool — between them
    // they name every character in the game, so "zero of B's IDs anywhere" is unachievable and
    // is not what §7 means.
    for (const raw of a.frames) {
      const frame = JSON.parse(raw) as { view?: { opponent?: unknown; rounds?: unknown } }
      if (!frame.view) continue
      const sealed = JSON.stringify({ opponent: frame.view.opponent, rounds: frame.view.rounds })
      for (const id of bPicks) {
        expect(sealed, `a frame to seat A leaked B's pick "${id}"`).not.toContain(id)
      }
    }

    // The ban, by contrast, is public at gate one — the mode's whole first act.
    const latest = JSON.stringify(a.view.opponent)
    expect(latest).toContain(bBan)
  })

  it('never sends a redacted field as null or a flag', () => {
    return seatedMatch({ modeId: 'bring-ban1' }).then(async ({ a, b }) => {
      await a.act(materialize(a.action('COMMIT')!, 'A'))
      await b.settle()

      // "The client must never receive a redacted value with a flag; it must receive nothing."
      for (const raw of b.frames) {
        expect(raw).not.toContain('"slots":null')
        expect(raw).not.toContain('REDACTED')
        expect(raw).not.toContain('"redacted"')
      }
    })
  })

  it('never puts a MatchState or an event log on the wire', async () => {
    const { a, b } = await seatedMatch()
    await playToCompletion(a, b, ['A', 'B', 'A'])

    // The outbound choke point sends `PlayerView` and nothing else. A leaked `log` would hand a
    // client every hidden commit in history, and a leaked `cursor` would hand it the program.
    for (const raw of a.frames) {
      expect(raw).not.toContain('"log"')
      expect(raw).not.toContain('"cursor"')
      expect(raw).not.toContain('"seed"')
      // `mode.program` is not a secret, but the client has no use for it and D18's instinct is
      // not to ship the rules to something that should be rendering decisions.
      expect(raw).not.toContain('"program"')
    }
  })
})

describe('idempotency — a double-clicked commit appends once', () => {
  it('replays the recorded outcome instead of re-running the action', async () => {
    const { roomCode, a } = await seatedMatch()
    const commit = materialize(a.action('COMMIT')!, 'A')

    await a.act(commit, 'same-key')
    await a.act(commit, 'same-key')
    await a.act(commit, 'same-key')

    const commits = (await eventsOf(roomCode)).filter((e) => e.payload.type === 'COMMIT')
    expect(commits).toHaveLength(1)
    // A retry still gets an answer — a client that heard nothing would retry forever.
    expect(a.viewCount).toBeGreaterThan(1)
  })

  it('replays a rejection too, so a retried illegal action stays illegal', async () => {
    const { a } = await seatedMatch()
    const illegal = { ...materialize(a.action('COMMIT')!, 'A'), picks: ['not-a-character'] }

    await a.act(illegal, 'bad-key')
    const first = a.lastRejection
    expect(first?.code).toBe('WRONG_COMMIT_SHAPE')

    await a.act(illegal, 'bad-key')
    expect(a.lastRejection?.code).toBe(first?.code)
    expect(a.lastRejection?.idempotencyKey).toBe('bad-key')
  })

  it('treats a different key as a different action', async () => {
    const { roomCode, a } = await seatedMatch()
    const commit = materialize(a.action('COMMIT')!, 'A')

    await a.act(commit, 'key-one')
    await a.act(commit, 'key-two')

    // The second is a genuinely new action and is judged on its merits. The draft module is
    // still current — it is waiting on B — so the engine's answer is DUPLICATE_COMMIT: §12 says
    // a sealed commit cannot be withdrawn, so it cannot be replaced either.
    expect(a.lastRejection?.code).toBe('DUPLICATE_COMMIT')
    expect((await eventsOf(roomCode)).filter((e) => e.payload.type === 'COMMIT')).toHaveLength(1)
  })

  it('refuses an action with no idempotency key', async () => {
    const { a } = await seatedMatch()
    a.send({
      type: 'ACTION',
      idempotencyKey: '',
      payload: materialize(a.action('COMMIT')!, 'A'),
    })
    await a.settle()
    expect(a.lastError?.code).toBe('MALFORMED')
  })
})

describe('the protocol refuses nonsense', () => {
  it('rejects a frame that is not JSON', async () => {
    const { a } = await seatedMatch()
    // Raw, because `send` would serialize the string into valid JSON and the server would then
    // correctly report UNKNOWN_MESSAGE instead — a different failure than the one under test.
    a.sendRaw('{ not json at all')
    await a.settle()
    expect(a.lastError?.code).toBe('MALFORMED')
  })

  it('rejects an unrecognized message type', async () => {
    const { a } = await seatedMatch()
    a.send({ type: 'DEMAND_VICTORY' } as never)
    await a.settle()
    expect(a.lastError?.code).toBe('UNKNOWN_MESSAGE')
  })

  it('rate limits a client stuck in a loop', async () => {
    // Not a defence against an attacker — §1 grants friendly opponents. A defence against a
    // held-down key or a retry bug turning one match into a five-figure request count.
    const { a } = await seatedMatch()
    for (let i = 0; i < 60; i++) a.send({ type: 'RESYNC' })
    await a.settle(40)
    expect(a.lastError?.code).toBe('RATE_LIMITED')
  })
})

describe('§11 free-plan headroom', () => {
  it('a full match costs well under 500 Durable Object requests', async () => {
    // Cloudflare bills a DO request per incoming HTTP request *and* per incoming WebSocket
    // message. Outbound frames are not billed, but they are counted here anyway so the number
    // is an over-estimate rather than a flattering one.
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'B', 'A'])

    // HTTP: 1 create + 2 seat claims + 2 socket upgrades.
    const httpRequests = 5
    const inboundMessages = countActions(a) + countActions(b)
    const outboundFrames = a.frames.length + b.frames.length
    const total = httpRequests + inboundMessages + outboundFrames

    expect(a.view.status).toBe('COMPLETE')
    expect(total).toBeLessThan(500)

    // §11's table budgets "a few hundred" against 100,000/day. Recorded so a regression that
    // makes the DO chatty shows up as a number rather than as a surprise invoice.
    expect(inboundMessages).toBeLessThan(60)
  })

  it('writes tens of SQLite rows, not thousands', async () => {
    const { roomCode, a, b } = await seatedMatch()
    await playToCompletion(a, b, ['A', 'B', 'A'])

    const events = await eventsOf(roomCode)
    // §11: "SQLite rows written/day — 100,000 free; a full Bo3 uses tens."
    expect(events.length).toBeLessThan(100)
    expect(events.length).toBeGreaterThan(20)
  })
})

/** Inbound messages this client sent — one DO request each, as Cloudflare bills them. */
function countActions(client: TestClient): number {
  return client.sentCount
}
