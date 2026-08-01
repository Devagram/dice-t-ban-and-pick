/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

import {
  createMatch,
  roster,
  materialize,
  playToCompletion,
  preview,
  seatedMatch,
  TestClient,
} from './client.js'

/**
 * **Phase 3 exit criteria: two headless clients play a complete match over WebSocket.**
 *
 * The clients here have no access to the engine. They render `legalActions` off the frames they
 * receive, exactly as §11.4 and D18 require of the real one — so anything these tests can do,
 * the Phase 4 client can do, and anything they cannot is a gap in the protocol rather than in
 * the test.
 */

describe('a full match over WebSocket', () => {
  for (const modeId of ['base', 'bring-ban1'] as const) {
    it(`${modeId} plays to a terminal state`, async () => {
      const { a, b } = await seatedMatch({ modeId, draftCount: 4 })

      expect(a.view.status).toBe('IN_PROGRESS')
      expect(a.view.seat).toBe('A')
      expect(b.view.seat).toBe('B')

      await playToCompletion(a, b, ['A', 'B', 'A'])

      for (const client of [a, b]) {
        expect(client.view.status).toBe('COMPLETE')
        expect(client.view.outcome).toBe('A')
        expect(client.view.rounds.map((r) => r.result)).toEqual(['A', 'B', 'A'])
      }
    })
  }

  it('reaches a drawn match, which is a legal terminal state (D21)', async () => {
    const { a, b } = await seatedMatch()
    await playToCompletion(a, b, ['TIE', 'TIE', 'TIE'])
    expect(a.view.outcome).toBe('DRAW')
    expect(a.view.you.score).toBe(1.5)
  })

  it('stops at 2–0 without playing the dead rubber (D21)', async () => {
    const { a, b } = await seatedMatch()
    await playToCompletion(a, b, ['A', 'A', 'A'])
    expect(a.view.outcome).toBe('A')
    expect(a.view.rounds[2]!.result).toBeNull()
  })

  it('auto-commits a forced select at draftCount 3, with no client round trip (D26)', async () => {
    const { a, b } = await seatedMatch({ draftCount: 3 })
    await playToCompletion(a, b, ['A', 'B', 'A'])

    // Neither client was ever offered a one-option select — the system committed it. The proof
    // available to a client is that every round resolved and every slot was spent.
    expect(a.view.status).toBe('COMPLETE')
    for (const client of [a, b]) {
      expect(client.view.you.slots!.every((s) => s.consumed)).toBe(true)
    }
  })

  it('gives both seats a frame on every state change', async () => {
    const { a, b } = await seatedMatch()
    const before = { a: a.viewCount, b: b.viewCount }

    const commit = a.action('COMMIT')!
    await a.act(materialize(commit, 'A'))

    // A's commit is sealed, but *that* it happened is public — B must learn it is now the only
    // seat being waited on, or "waiting for opponent" is unrenderable.
    expect(a.viewCount).toBeGreaterThan(before.a)
    expect(b.viewCount).toBeGreaterThan(before.b)
    expect(b.view.opponent.hasCommitted).toBe(true)
  })
})

describe('the lobby (§12)', () => {
  it('renders the whole ruleset before a seat is taken — seating is the consent', async () => {
    const banned = (await roster())[0]!
    const { roomCode } = await createMatch({ draftCount: 3, globalBanned: [banned.id] })
    const lobby = await preview(roomCode)

    expect(lobby.status).toBe('LOBBY')
    expect(lobby.modeLabel).toBe('Standard Bo3 — draft 3')
    // "A host quietly switching from 4 picks to 3 is exactly the kind of change the joiner must
    // see", so the parameter value has to be on the wire, not implied by the mode name.
    expect(lobby.ruleset.parameters).toEqual({ draftCount: 3 })
    expect(lobby.ruleset.onTie.scoring).toBe('HALF_POINT')
    expect(lobby.ruleset.match.resolution).toBe('ALWAYS_3_ROUNDS')
    // Bans are resolved to characters so the client never has to look one up by id.
    expect(lobby.globalBannedCharacters.map((c) => c.name)).toEqual([banned.name])
    expect(lobby.seatsAvailable).toEqual(['A', 'B'])
  })

  it('carries the room code in the join URL and nothing else (D20)', async () => {
    const created = await createMatch()
    expect(created.joinUrl).toBe(`https://example.com/j/${created.roomCode}`)
    expect(created.joinUrl).not.toContain('#')
    expect(created.joinUrl).not.toContain('hash')
  })

  it('shows seats filling up', async () => {
    const { roomCode } = await createMatch()
    expect((await preview(roomCode)).seatsAvailable).toEqual(['A', 'B'])
    await TestClient.claimSeat(roomCode)
    expect((await preview(roomCode)).seatsAvailable).toEqual(['B'])
    await TestClient.claimSeat(roomCode)
    expect((await preview(roomCode)).seatsAvailable).toEqual([])
  })

  it('refuses a third seat', async () => {
    const { roomCode } = await createMatch()
    await TestClient.claimSeat(roomCode)
    await TestClient.claimSeat(roomCode)
    const third = await SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
      method: 'POST',
    })
    expect(third.status).toBe(409)
  })

  it('opens play the moment the second seat fills (§12.4)', async () => {
    const { roomCode } = await createMatch()
    const a = await TestClient.claimSeat(roomCode)
    await a.connect()
    expect(a.view.status).toBe('LOBBY')

    const b = await TestClient.claimSeat(roomCode)
    await b.connect()
    await a.settle()
    expect(a.view.status).toBe('IN_PROGRESS')
  })

  it('404s a room code nobody created', async () => {
    expect((await SELF.fetch('https://example.com/api/match/ZZZZZZ/preview')).status).toBe(404)
  })

  it('rejects a malformed room code before reaching a Durable Object', async () => {
    expect((await SELF.fetch('https://example.com/api/match/nope/preview')).status).toBe(400)
  })
})

describe('the host cannot ban a match into unplayability (Phase 2 finding F4)', () => {
  it('refuses a global ban list that breaks the §13 roster floor', async () => {
    // The loader validates the roster alone supports the mode, but `globalBanned` is empty at
    // load time — the host has not chosen yet. This is the only place the real number is known,
    // and it has to be caught before a joiner consents by sitting down.
    // Ban everything but five, whatever the roster size happens to be. Drafting 4 with a meta
    // ban needs 5 — and since D28 the ban you brought last set may be denied too, so the floor
    // is 6. Computed rather than hardcoded so this keeps testing the *rule* as the game gains
    // heroes, instead of quietly becoming a test that bans a fixed six of forty.
    const all = (await roster()).map((c) => c.id)
    const response = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modeId: 'base',
        parameters: { draftCount: 4 },
        globalBanned: all.slice(0, all.length - 5),
      }),
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; detail: string }
    expect(body.error).toBe('ROSTER_VIABILITY')
    expect(body.detail).toContain('needs at least 6')
  })

  it('allows a ban list that stops exactly one short of the floor', async () => {
    // One fewer ban leaves six, which is exactly the floor: `draftCount + 1` for the meta ban,
    // plus one more for D28's possible denial. The boundary is the interesting case — off by one
    // either way blocks legal matches or allows unplayable ones, and both fail in front of two
    // people who have already consented by sitting down.
    const all = (await roster()).map((c) => c.id)
    const { roomCode } = await createMatch({ globalBanned: all.slice(0, all.length - 6) })
    expect((await preview(roomCode)).ruleset.globalBanned).toHaveLength(all.length - 6)
  })

  it('needs one fewer when the host allows repeat bans', async () => {
    // The floor is derived, not asserted (§13). Turning D28 off gives the character back, and a
    // ban list that is one too many with the rule on is exactly right with it off.
    const all = (await roster()).map((c) => c.id)
    const tooMany = all.slice(0, all.length - 5)

    const refused = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modeId: 'base',
        parameters: { draftCount: 4 },
        globalBanned: tooMany,
      }),
    })
    expect(refused.status).toBe(400)

    const allowed = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modeId: 'base',
        parameters: { draftCount: 4 },
        globalBanned: tooMany,
        allowRepeatBans: true,
      }),
    })
    expect(allowed.status).toBe(201)
  })

  it('refuses parameters no variant was validated for (D25)', async () => {
    const response = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'base', parameters: { draftCount: 7 }, globalBanned: [] }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('UNKNOWN_PARAMETERS')
  })

  it('refuses an unknown mode', async () => {
    const response = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'nonsense', parameters: {}, globalBanned: [] }),
    })
    expect(response.status).toBe(400)
  })
})

/**
 * Create is unauthenticated by design — anyone with the URL can open a room — so its body is
 * fully untrusted. Found by hand-posting a plausible-but-wrong shape (`{modeId, draftCount}`
 * rather than `{modeId, parameters}`) against a dev server and getting a 500 with a stack trace.
 */
describe('a malformed create body is a 400, not a 500', () => {
  const post = (body: string) =>
    SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

  it.each([
    ['no parameters at all', '{"modeId":"base"}'],
    ['parameters as a string', '{"modeId":"base","parameters":"draftCount=4"}'],
    ['parameters null', '{"modeId":"base","parameters":null}'],
    [
      'globalBanned not an array',
      '{"modeId":"base","parameters":{"draftCount":4},"globalBanned":7}',
    ],
    ['not JSON', 'not json at all'],
    ['a bare number', '42'],
    ['null', 'null'],
    ['empty', ''],
  ])('%s', async (_label, body) => {
    const response = await post(body)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
  })

  it('drops non-string entries from globalBanned rather than snapshotting them', async () => {
    // The ban list is snapshotted into the creation event and replayed forever (§11
    // non-negotiable 2), so a stray number in it outlives the request that sent it.
    const response = await post(
      '{"modeId":"base","parameters":{"draftCount":4},"globalBanned":["barbarian",7,null]}',
    )
    expect(response.status).toBe(201)
    const { roomCode } = (await response.json()) as { roomCode: string }
    expect((await preview(roomCode)).ruleset.globalBanned).toEqual(['barbarian'])
  })
})
