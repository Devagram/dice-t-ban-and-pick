/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

import { materialize, playToCompletion, seatedMatch } from './client.js'

/**
 * **D52 — one game, one character each, and nothing in between.**
 *
 * The smallest mode the grammar expresses, and the tests worth having are about what it *does not*
 * do: no ban to place, no roll to win, no selection to make. Both seats lock a character, the picks
 * open, and the only thing left is to say who won.
 *
 * The engine work this needed was zero, which is §1's claim that modes are configuration — a claim
 * only worth believing when a mode this unlike the others is added without touching it.
 */

describe('the one-pick mode', () => {
  it('is offered to a host like any other', async () => {
    const modes = (await (await SELF.fetch('https://example.com/api/modes')).json()) as {
      modeId: string
      label: string
      parameters: Record<string, unknown>
    }[]

    const mine = modes.find((m) => m.modeId === 'bo1-pick1')!
    expect(mine).toBeTruthy()
    expect(mine.label).toContain('no bans')
    // Nothing to parameterise: at two picks this would be a different game with a decision in it.
    expect(Object.keys(mine.parameters)).toEqual([])
  })

  it('asks each seat for one character and nothing else', async () => {
    const match = await seatedMatch({ modeId: 'bo1-pick1', players: ['p1-1', 'p1-2'] })

    // The only thing either seat is ever asked for.
    expect(match.a.actions().map((x) => x.type)).toEqual(['COMMIT'])
    expect(match.a.view.rounds).toHaveLength(1)
  })

  it('goes straight from both picks to the result', async () => {
    const match = await seatedMatch({ modeId: 'bo1-pick1', players: ['p1-3', 'p1-4'] })

    for (const client of [match.a, match.b]) {
      await client.act(materialize(client.action('COMMIT')!, client.seat))
    }
    await match.a.settle(40)

    /*
     * The whole point of the format: once both are locked there is no ban to place, no roll to win
     * and no selection to make — D26 auto-commits the one legal option for each seat — so the next
     * thing either player is asked is who won.
     */
    const offered = match.a.actions().map((x) => x.type)
    expect(offered).toContain('REPORT_RESULT')
    expect(offered.some((t) => t === 'BAN' || t === 'ROLL' || t === 'SELECT')).toBe(false)
  })

  it('records the character each seat played, and no counter-pick', async () => {
    const match = await seatedMatch({ modeId: 'bo1-pick1', players: ['p1-5', 'p1-6'] })
    await playToCompletion(match.a, match.b, ['A'])
    await match.a.settle(40)

    const stored = await recorded(match.roomCode)
    const detail = stored.detail as {
      rounds: (string | null)[]
      modeId?: string
      firstToSelect?: (string | null)[]
      seats: Record<'A' | 'B', { lineup: (string | null)[]; drafted: string[] }>
    }

    expect(detail.modeId).toBe('bo1-pick1')
    expect(detail.rounds).toEqual(['A'])
    // D45 — the hero board still learns what was played, because a forced select is still a select
    // and still consumes the slot.
    expect(detail.seats.A.drafted).toHaveLength(1)
    expect(detail.seats.A.lineup[0]).toBe(detail.seats.A.drafted[0])

    /*
     * D51/D52 — and no counter-pick, which is the interaction worth pinning. Both selections were
     * forced, and D26 is explicit that a decision with one option is not a decision: filing an
     * order here would credit every round of this mode with an answer nobody chose.
     */
    expect(detail.firstToSelect).toEqual([null])
  })

  it('reaches the boards as an ordinary game', async () => {
    const match = await seatedMatch({ modeId: 'bo1-pick1', players: ['p1-7', 'p1-8'] })
    await playToCompletion(match.a, match.b, ['B'])
    await match.a.settle(40)
    await recorded(match.roomCode)

    const page = (await (await SELF.fetch('https://example.com/api/stats')).json()) as {
      sequentialRounds: number
      counterPicked: unknown[]
      picked: { characterId: string; count: number }[]
    }
    // It contributes drafts like any other match, and nothing to the two figures it cannot answer.
    expect(page.picked.length).toBeGreaterThan(0)
    expect(page.sequentialRounds).toBe(0)
    expect(page.counterPicked).toEqual([])

    const heroes = (await (await SELF.fetch('https://example.com/api/heroes')).json()) as {
      heroes: { wins: number; losses: number }[]
      unattributedRounds: number
    }
    /*
     * One round, one hero a side: D45 wrote the lineup, so nothing here needs deducing.
     *
     * Every match this suite plays is a mirror — the headless client takes the first legal option,
     * and with one pick each that is the same character both sides — so the hero it lands on wins
     * and loses the same round. D1 allows exactly that, and the board counts both halves, which is
     * why this asserts a hero *was counted* rather than a particular record.
     */
    expect(heroes.unattributedRounds).toBe(0)
    expect(heroes.heroes.some((h) => h.wins > 0 && h.losses > 0)).toBe(true)
  })
})

/** The stored record for a room, once the match object has filed it. */
async function recorded(roomCode: string) {
  for (let i = 0; i < 80; i++) {
    const body = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
      matches: { roomCode: string; detail: unknown }[]
    }
    const mine = body.matches.find((m) => m.roomCode === roomCode)
    if (mine) return mine
    await scheduler.wait(1)
  }
  throw new Error(`${roomCode} never reached the history`)
}
