import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch } from './client.js'

/**
 * A new match between two people with history starts level.
 *
 * Written for a report that a fresh room "says the score is already 1-0". Nothing carries a score
 * across matches — D28 carries one ban and D29 carries results, neither of which touches
 * `seats.score` — but the pair with history is the case worth pinning, because it is the only one
 * where anything at all is remembered about these two.
 */
describe('a new match against a familiar opponent', () => {
  it('starts 0-0 with no rounds reported', async () => {
    const players: [string, string] = ['fresh-1', 'fresh-2']
    const first = await seatedMatch({ modeId: 'base', draftCount: 4, players })
    await playToCompletion(first.a, first.b, ['A', 'A', 'A'])
    expect(first.a.view.outcome).toBe('A')
    await first.a.settle(40)

    // Same two people, brand new room, nothing drafted or banned yet.
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4, players })

    expect(a.view.you.score).toBe(0)
    expect(a.view.opponent.score).toBe(0)
    expect(b.view.you.score).toBe(0)
    expect(a.view.rounds.every((r) => r.result === null)).toBe(true)
    expect(a.view.outcome).toBeNull()
    // And it is genuinely at the start: the draft is what it is waiting for.
    expect(a.view.phase?.roundIndex ?? null).toBeNull()
  })
})
