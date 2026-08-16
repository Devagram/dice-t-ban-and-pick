/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

import { createMatch, eventually, playToCompletion, seatedMatch } from './client.js'
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

    // Waited for rather than slept past: the registry write rides a `waitUntil` so no player has
    // to wait for the leaderboard, which makes every read here a "once it lands".
    const record = await eventually(
      () => h2h(players[0], players[1]),
      (r) => r.matches.length === 1,
      'the match reaching the registry',
    )
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
    expect(a.view.outcome).toBe('A')

    const table = await eventually(
      async () => (await standings()).filter((s) => players.includes(s.playerId)),
      (rows) => rows.length === 2,
      'both players in the table',
    )
    expect(table.map((s) => s.playerId)).toEqual(['lb-x', 'lb-y'])
    expect(table[0]).toMatchObject({ playerId: 'lb-x', wins: 1, losses: 0, draws: 0 })
    expect(table[1]).toMatchObject({ playerId: 'lb-y', wins: 0, losses: 1, draws: 0 })
  })

  it('records a draw as a draw for both', async () => {
    // D21 — three tied rounds is 1.5–1.5 and a legal terminal state. Half a win each would be a
    // different game. At 3, because D30's overtime decides that score at 4.
    const players: [string, string] = ['lb-d1', 'lb-d2']
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 3, players })
    await playToCompletion(a, b, ['TIE', 'TIE', 'TIE'])
    expect(a.view.outcome).toBe('DRAW')

    const record = await eventually(
      () => h2h(players[0], players[1]),
      (r) => r.matches.length === 1,
      'the drawn match reaching the registry',
    )
    expect(record).toMatchObject({ wins: 0, losses: 0, draws: 1 })
  })

  it('refuses an unnamed seat outright', async () => {
    /*
     * A name stopped being decoration when it became a record. An unnamed seat would leave the
     * match off the leaderboard and give the no-repeat-ban rule nothing to key on — the game
     * would quietly behave differently for that player. The lobby disables the button, but a
     * disabled button is a suggestion; this is the rule.
     */
    const { roomCode } = await createMatch({ modeId: 'base', draftCount: 4 })
    const anonymous = await SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
      method: 'POST',
    })
    expect(anonymous.status).toBe(400)
    expect(((await anonymous.json()) as { error: string }).error).toBe('NAME_REQUIRED')

    // And the seat is still free afterwards — a refused claim must not consume one.
    const named = await SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'lb-named', displayName: 'Named' }),
    })
    expect(named.status).toBe(201)
  })

  it('claims a name over HTTP, and refuses a second claimant', async () => {
    expect((await claim('lb-first', 'Unique Name')).status).toBe(200)
    expect((await claim('lb-second', 'Unique Name')).status).toBe(409)
  })
})
