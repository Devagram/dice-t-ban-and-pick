/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import type { HeadToHead, MatchRecord, Standing } from '../src/RegistryDO.js'

/**
 * D29's store: claimed names, results, and the standings derived from them.
 *
 * The properties worth defending are not the shapes. They are that a name cannot be stolen, and
 * that a result which gets undone stops counting — because D15 lets a finished match un-finish,
 * and a leaderboard that quietly disagrees with what happened is worse than no leaderboard.
 */

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName(crypto.randomUUID()))

const claim = (stub: DurableObjectStub, playerId: string, displayName: string) =>
  stub.fetch('https://r/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, displayName }),
  })

const record = (stub: DurableObjectStub, match: Partial<MatchRecord>) =>
  stub.fetch('https://r/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomCode: 'ROOM01',
      playedAt: 1,
      a: { id: 'p-a', name: 'Tom' },
      b: { id: 'p-b', name: 'Alex' },
      winnerId: 'p-a',
      scoreA: 2,
      scoreB: 1,
      detail: null,
      ...match,
    }),
  })

const standings = async (stub: DurableObjectStub): Promise<Standing[]> =>
  ((await (await stub.fetch('https://r/standings')).json()) as { standings: Standing[] }).standings

const h2h = async (stub: DurableObjectStub, a: string, b: string): Promise<HeadToHead> =>
  (await (await stub.fetch(`https://r/head-to-head?a=${a}&b=${b}`)).json()) as HeadToHead

describe('a name can be owned', () => {
  it('goes to the first browser that uses it', async () => {
    const r = registry()
    expect((await claim(r, 'p-1', 'Tom')).status).toBe(200)
    expect((await claim(r, 'p-2', 'Tom')).status).toBe(409)
  })

  it('is case- and space-insensitive, because "Tom" and "tom " are one person', async () => {
    const r = registry()
    await claim(r, 'p-1', 'Tom')
    expect((await claim(r, 'p-2', '  tom ')).status).toBe(409)
  })

  it('lets the owner rename freely, and frees the name they left', async () => {
    // Holding "Tom" forever after renaming would take it out of a group of four people.
    const r = registry()
    await claim(r, 'p-1', 'Tom')
    expect((await claim(r, 'p-1', 'Tom B')).status).toBe(200)
    expect((await claim(r, 'p-2', 'Tom')).status).toBe(200)
  })

  it('refuses an empty name rather than storing one', async () => {
    expect((await claim(registry(), 'p-1', '   ')).status).toBe(400)
  })
})

describe('an undone result stops counting', () => {
  it('keeps one match when the same room is recorded twice with a different winner', async () => {
    /*
     * The case D15 makes real: either seat may undo the last result *including on the final
     * round*, which reopens a completed match — so a match can complete, un-complete, and
     * complete again the other way. An incrementing counter would show two matches and a wrong
     * winner, and nothing downstream would ever notice.
     */
    const r = registry()
    await record(r, { winnerId: 'p-a', scoreA: 2, scoreB: 1 })
    await record(r, { winnerId: 'p-b', scoreA: 1, scoreB: 2 })

    const table = await standings(r)
    const tom = table.find((s) => s.playerId === 'p-a')!
    const alex = table.find((s) => s.playerId === 'p-b')!

    expect(tom.wins + tom.losses + tom.draws).toBe(1)
    expect(tom.losses).toBe(1)
    expect(alex.wins).toBe(1)
    expect((await h2h(r, 'p-a', 'p-b')).matches).toHaveLength(1)
  })

  it('turns a decided match into a draw when it is re-recorded as one', async () => {
    const r = registry()
    await record(r, { winnerId: 'p-a' })
    await record(r, { winnerId: null, scoreA: 1.5, scoreB: 1.5 })

    const table = await standings(r)
    expect(table.every((s) => s.wins === 0 && s.losses === 0)).toBe(true)
    expect(table.every((s) => s.draws === 1)).toBe(true)
  })
})

describe('head-to-head is one record read from either side', () => {
  it('mirrors, rather than being stored twice', async () => {
    const r = registry()
    await record(r, { roomCode: 'R1', winnerId: 'p-a' })
    await record(r, { roomCode: 'R2', winnerId: 'p-a' })
    await record(r, { roomCode: 'R3', winnerId: 'p-b' })

    const forTom = await h2h(r, 'p-a', 'p-b')
    const forAlex = await h2h(r, 'p-b', 'p-a')

    expect([forTom.wins, forTom.losses]).toEqual([2, 1])
    // The same row read the other way round; two stored records could drift apart.
    expect([forAlex.wins, forAlex.losses]).toEqual([1, 2])
  })

  it('finds the pair whichever seat each player took', async () => {
    const r = registry()
    await record(r, {
      roomCode: 'R1',
      a: { id: 'p-a', name: 'Tom' },
      b: { id: 'p-b', name: 'Alex' },
    })
    await record(r, {
      roomCode: 'R2',
      a: { id: 'p-b', name: 'Alex' },
      b: { id: 'p-a', name: 'Tom' },
    })
    expect((await h2h(r, 'p-a', 'p-b')).matches).toHaveLength(2)
  })

  it('counts a draw as a draw, not as half a win', async () => {
    const r = registry()
    await record(r, { roomCode: 'R1', winnerId: null, scoreA: 1.5, scoreB: 1.5 })
    const record1 = await h2h(r, 'p-a', 'p-b')
    expect(record1).toMatchObject({ wins: 0, losses: 0, draws: 1 })
  })

  it('is empty for two people who have never met', async () => {
    expect(await h2h(registry(), 'nobody-1', 'nobody-2')).toMatchObject({
      wins: 0,
      losses: 0,
      draws: 0,
      matches: [],
    })
  })
})

describe('rounds are counted as well as matches', () => {
  it('turns a 2–1 win into two round wins and one round loss', async () => {
    const r = registry()
    await record(r, { winnerId: 'p-a', detail: { rounds: ['A', 'B', 'A'] } })

    const [tom, alex] = await standings(r).then((t) => [
      t.find((s) => s.playerId === 'p-a')!,
      t.find((s) => s.playerId === 'p-b')!,
    ])
    expect(tom).toMatchObject({ wins: 1, roundWins: 2, roundLosses: 1, roundDraws: 0 })
    expect(alex).toMatchObject({ losses: 1, roundWins: 1, roundLosses: 2, roundDraws: 0 })
  })

  it('counts a tied round for both sides', async () => {
    const r = registry()
    await record(r, { winnerId: null, detail: { rounds: ['TIE', 'TIE', 'TIE'] } })
    const table = await standings(r)
    expect(table.every((s) => s.roundDraws === 3 && s.roundWins === 0)).toBe(true)
  })

  it('ignores a round nobody played', async () => {
    // `stopWhenDecided` ends a match at 2–0, leaving the third round null. Counting it as
    // anything would invent a result.
    const r = registry()
    await record(r, { winnerId: 'p-a', detail: { rounds: ['A', 'A', null] } })
    const tom = (await standings(r)).find((s) => s.playerId === 'p-a')!
    expect(tom.roundWins + tom.roundLosses + tom.roundDraws).toBe(2)
  })

  it('survives a record with no round detail at all', async () => {
    const r = registry()
    await record(r, { winnerId: 'p-a', detail: null })
    const tom = (await standings(r)).find((s) => s.playerId === 'p-a')!
    expect(tom).toMatchObject({ wins: 1, roundWins: 0 })
  })
})

describe('the table ranks and refuses nonsense', () => {
  it('orders by wins, then by fewer losses', async () => {
    const r = registry()
    await record(r, {
      roomCode: 'R1',
      a: { id: 'x', name: 'X' },
      b: { id: 'y', name: 'Y' },
      winnerId: 'x',
    })
    await record(r, {
      roomCode: 'R2',
      a: { id: 'x', name: 'X' },
      b: { id: 'z', name: 'Z' },
      winnerId: 'x',
    })
    await record(r, {
      roomCode: 'R3',
      a: { id: 'y', name: 'Y' },
      b: { id: 'z', name: 'Z' },
      winnerId: 'y',
    })

    expect((await standings(r)).map((s) => s.playerId)).toEqual(['x', 'y', 'z'])
  })

  it('400s a malformed record rather than storing half of it', async () => {
    const r = registry()
    const bad = await r.fetch('https://r/record', { method: 'POST', body: 'not json' })
    expect(bad.status).toBe(400)
    expect(await standings(r)).toEqual([])
  })
})
