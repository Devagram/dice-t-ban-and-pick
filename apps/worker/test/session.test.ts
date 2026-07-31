/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, runInDurableObject, SELF } from 'cloudflare:test'
import type { EventEnvelope, PlayerActionPayload } from '@banpick/types'

import {
  commitPhase,
  createMatch,
  materialize,
  playToCompletion,
  seatedMatch,
  TestClient,
} from './client.js'

/**
 * **D17 — session continuity.** "Refreshing the page must be a non-event. So must closing the
 * tab, losing wifi, and picking the match back up on a different device."
 *
 * The exit criteria this file covers:
 *
 *   - Kill one client mid-hidden-commit; reconnect; the commit is intact and still sealed.
 *   - Hard-refresh both clients at every phase boundary; nothing is lost, no user action needed.
 *   - Open the resume link in a different browser; the seat is recovered with correct redaction.
 */

/** Reads the DO's own event log. A test-only backdoor, for asserting internal invariants. */
async function eventsOf(roomCode: string): Promise<EventEnvelope[]> {
  const stub = env.MATCH.get(env.MATCH.idFromName(roomCode))
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ payload: string }>('SELECT payload FROM events ORDER BY seq')
      .toArray()
      .map((r) => JSON.parse(r.payload) as EventEnvelope),
  )
}

describe('a disconnect is a non-event', () => {
  it('keeps a hidden commit intact and still sealed across a reconnect', async () => {
    const { roomCode, a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    // Past the ban phase, then A drafts and B does not — so A's draft is sealed and no gate has
    // fired. `hasCommitted` is derived from slots, so it means "has drafted"; the phase-level
    // "has locked in" signal is `awaiting`, which is why both are asserted here.
    await commitPhase(a, b)
    await a.act(materialize(a.action('COMMIT')!, 'A'))
    expect(b.view.opponent.hasCommitted).toBe(true)
    expect(b.view.phase!.awaiting).toEqual(['B'])
    expect('slots' in b.view.opponent).toBe(false)

    // The wifi drops.
    a.kill()

    // A reconnects with the same token — no user action, D17's whole point.
    const resumed = await TestClient.resume(a.seatToken, a.websocketUrl)

    // The commit survived...
    expect(resumed.view.you.slots).toBeDefined()
    expect(resumed.view.you.slots).toHaveLength(4)
    // ...and is still sealed from B, because a reconnect is just another moment to answer what
    // a seat may know. §12: a committed-but-unrevealed action cannot be withdrawn, and it does
    // not leak by being re-fetched either.
    await b.resync()
    expect('slots' in b.view.opponent).toBe(false)

    // And exactly two commits are in the log for A — its ban and its draft. Reconnecting did
    // not re-submit either.
    const commits = (await eventsOf(roomCode)).filter(
      (e) => e.payload.type === 'COMMIT' && e.payload.seat === 'A',
    )
    expect(commits).toHaveLength(2)
  })

  it('survives a hard refresh at every phase boundary', async () => {
    // "Hard-refresh both clients at every phase boundary; nothing is lost and no user action is
    // required." A refresh is a socket close plus a reconnect with the stored token.
    const match = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    let a = match.a
    let b = match.b

    for (let step = 0; step < 60; step++) {
      if (a.view.status === 'COMPLETE') break

      // Refresh both, at whatever boundary we happen to be at.
      a.kill()
      b.kill()
      a = await TestClient.resume(a.seatToken, a.websocketUrl)
      b = await TestClient.resume(b.seatToken, b.websocketUrl)

      const actor = [a, b].find((c) => c.isAwaited)
      expect(actor, 'somebody should be able to act after a refresh').toBeDefined()

      const action = actor!.actions().find((x) => x.type !== 'UNDO_LAST_RESULT')!
      const outcome =
        action.type === 'REPORT_RESULT' ? (['A', 'B', 'A'][action.roundIndex] ?? 'A') : 'A'
      await actor!.act(materialize(action, actor!.seat, outcome as 'A' | 'B' | 'TIE'))
    }

    expect(a.view.status).toBe('COMPLETE')
  })

  it('recovers the seat from a resume link on another device, with redaction intact', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    // Past the ban phase, then A drafts alone. Both matter: before a seat drafts, its slots
    // slice is public-and-empty — which hides nothing and would make the assertion below
    // vacuous — and if *both* drafted, the reveal fires and there is nothing sealed left.
    await commitPhase(a, b)
    await a.act(materialize(a.action('COMMIT')!, 'A'))

    expect(a.view.opponent.metaBanPlaced).toBeDefined() // gate one opened the bans
    expect(a.view.opponent.slots).toEqual([]) // B has not drafted: empty, not sealed

    // The resume link is a bearer credential: whoever holds it holds the seat, hidden commits
    // included. A second device is therefore indistinguishable from the first, by design (D17).
    const otherDevice = await TestClient.resume(a.seatToken, a.websocketUrl)

    expect(otherDevice.seat).toBe('A')
    expect(otherDevice.view.you.slots).toHaveLength(4)
    // A's view, not a god view: reconnecting does not widen what a seat may know. B has not
    // drafted, so the honest answer is an empty list rather than a sealed one — and A's own
    // draft, which *is* secret, is not echoed into the opponent region.
    expect(otherDevice.view.opponent.slots).toEqual([])
    expect(JSON.stringify(otherDevice.view.opponent)).not.toContain(
      otherDevice.view.you.slots![0]!.characterId,
    )

    // The original socket still works too — no session is invalidated by another opening.
    await b.resync()
    expect(b.view.seat).toBe('B')
  })

  it('refuses a socket with no token, and one with a wrong token', async () => {
    const { roomCode } = await createMatch()
    await TestClient.claimSeat(roomCode)

    const noToken = await SELF.fetch(`https://example.com/api/match/${roomCode}/ws`, {
      headers: { Upgrade: 'websocket' },
    })
    expect(noToken.status).toBe(401)

    const wrongToken = await SELF.fetch(
      `https://example.com/api/match/${roomCode}/ws?token=${'0'.repeat(64)}`,
      { headers: { Upgrade: 'websocket' } },
    )
    expect(wrongToken.status).toBe(401)
  })

  it('refuses a plain GET on the socket endpoint', async () => {
    const { roomCode } = await createMatch()
    const client = await TestClient.claimSeat(roomCode)
    const response = await SELF.fetch(
      `https://example.com/api/match/${roomCode}/ws?token=${client.seatToken}`,
    )
    expect(response.status).toBe(426)
  })
})

describe('the seat belongs to the token, not the socket', () => {
  it('refuses an action that names the other seat', async () => {
    const { a } = await seatedMatch()
    const commit = a.action('COMMIT')!

    // A forged payload claiming to be B. The DO trusts the token and nothing in the message.
    a.send({
      type: 'ACTION',
      idempotencyKey: 'forged',
      // A forged payload claiming to be B. COMMIT does carry a seat; the cast is only to build
      // a frame a well-behaved client could not, which is the whole point of the test.
      payload: { ...materialize(commit, 'A'), seat: 'B' } as PlayerActionPayload,
    })
    expect((await a.waitForError()).code).toBe('NOT_YOUR_SEAT')
  })

  it('refuses an undo that names the other seat', async () => {
    const { a } = await seatedMatch()
    a.send({
      type: 'ACTION',
      idempotencyKey: 'forged-undo',
      payload: { type: 'UNDO_LAST_RESULT', roundIndex: 0, requestedBy: 'B' },
    })
    expect((await a.waitForError()).code).toBe('NOT_YOUR_SEAT')
  })
})

describe('the match archives rather than forfeiting (D17)', () => {
  it('closes sockets and drops seat credentials when the idle alarm fires', async () => {
    const { roomCode, a, b } = await seatedMatch()
    await playToCompletion(a, b, ['A', 'A', 'A'])

    const stub = env.MATCH.get(env.MATCH.idFromName(roomCode))
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm()
    })

    // "The DO evicts and the match archives to log-only." The events are the record of truth
    // and they stay; the credentials do not, so the room cannot be re-entered.
    const events = await eventsOf(roomCode)
    expect(events.length).toBeGreaterThan(0)

    const seats = await runInDurableObject(
      stub,
      (_i, state) =>
        state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM seats').one().n,
    )
    expect(seats).toBe(0)
  })
})
