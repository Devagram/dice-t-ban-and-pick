/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

import { playToCompletion, seatedMatch } from './client.js'
import type { HeadToHead, Standing } from '../src/RegistryDO.js'

/**
 * D29 end to end: play a match, and it shows up.
 *
 * The store's own guarantees are covered in `registry.test.ts`. What is checked here is the wiring
 * — that a finished match reaches the registry with the right winner, the right names, and the
 * detail that answers "what do they always play?".
 */

const standings = async (): Promise<Standing[]> =>
  (
    (await (await SELF.fetch('https://example.com/api/standings')).json()) as {
      standings: Standing[]
    }
  ).standings

const h2h = async (a: string, b: string): Promise<HeadToHead> =>
  (await (
    await SELF.fetch(`https://example.com/api/head-to-head?a=${a}&b=${b}`)
  ).json()) as HeadToHead

const claim = (playerId: string, displayName: string) =>
  SELF.fetch('https://example.com/api/player/name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, displayName }),
  })

describe('a finished match reaches the leaderboard', () => {
  it('records the winner, both names, and what was played', async () => {
    const players: [string, string] = ['lb-tom', 'lb-alex']
    await claim(players[0], 'Tom')
    await claim(players[1], 'Alex')

    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4, players })
    await playToCompletion(a, b, ['A', 'A', 'A'])
    await a.settle(40)

    const record = await h2h(players[0], players[1])
    expect(record.matches).toHaveLength(1)
    expect(record.wins).toBe(1)
    expect(record.losses).toBe(0)

    const detail = record.matches[0]!.detail as {
      seats: { A: { drafted: string[]; played: string[] } }
    }
    // The characters, not the event log — enough to ask what somebody always brings.
    expect(detail.seats.A.drafted).toHaveLength(4)
    expect(detail.seats.A.played.length).toBeGreaterThan(0)
  })

  it('puts the winner above the loser in the table', async () => {
    const players: [string, string] = ['lb-x', 'lb-y']
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4, players })
    // Seat A wins every round, and `seatedMatch` hands the first id to whoever got seat A.
    await playToCompletion(a, b, ['A', 'A', 'A'])
    await a.settle(40)
    expect(a.view.outcome).toBe('A')

    const table = (await standings()).filter((s) => players.includes(s.playerId))
    expect(table.map((s) => s.playerId)).toEqual(['lb-x', 'lb-y'])
    expect(table[0]).toMatchObject({ playerId: 'lb-x', wins: 1, losses: 0, draws: 0 })
    expect(table[1]).toMatchObject({ playerId: 'lb-y', wins: 0, losses: 1, draws: 0 })
  })

  it('records a draw as a draw for both', async () => {
    // D21 — three tied rounds is 1.5–1.5 and a legal terminal state. Half a win each would be a
    // different game.
    const players: [string, string] = ['lb-d1', 'lb-d2']
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4, players })
    await playToCompletion(a, b, ['TIE', 'TIE', 'TIE'])
    await a.settle(40)
    expect(a.view.outcome).toBe('DRAW')

    const record = await h2h(players[0], players[1])
    expect(record).toMatchObject({ wins: 0, losses: 0, draws: 1 })
  })

  it('leaves anonymous matches off it entirely', async () => {
    // No identity, nothing to rank. An older client behaves exactly as it always did.
    const before = (await standings()).length
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'A', 'A'])
    await a.settle(40)
    expect((await standings()).length).toBe(before)
  })

  it('claims a name over HTTP, and refuses a second claimant', async () => {
    expect((await claim('lb-first', 'Unique Name')).status).toBe(200)
    expect((await claim('lb-second', 'Unique Name')).status).toBe(409)
  })
})
