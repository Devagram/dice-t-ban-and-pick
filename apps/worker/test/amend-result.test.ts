import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch, type TestClient } from './client.js'

/**
 * **D33 — correcting a round after the fact.**
 *
 * D15's undo covers the result you just entered and shuts as soon as the next round starts. This
 * covers the one you notice later, which is the mistake that actually survives to matter. The
 * interesting cases are all downstream: changing an old round can change who won the match, and
 * can bring a round back that `stopWhenDecided` skipped.
 */

function amend(client: TestClient, roundIndex: 0 | 1 | 2 | 3, outcome: 'A' | 'B' | 'TIE') {
  return client.act({ type: 'AMEND_RESULT', roundIndex, outcome, amendedBy: client.seat })
}

describe('correcting a round mid-match', () => {
  it('changes the score for a round two rounds ago', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'B', 'A'])
    expect(a.view.outcome).toBe('A')

    // Round 0 was actually B's. Nothing in D15's window reaches back this far.
    await amend(a, 0, 'B')

    expect(a.view.rounds[0]?.result).toBe('B')
    // 2-1 to A becomes 1-2 to B, and the match re-decides itself rather than keeping its answer.
    expect(a.view.outcome).toBe('B')
    expect(b.view.outcome).toBe('B')
  })

  it('tells the other seat who changed what', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'B', 'A'])
    await amend(a, 0, 'TIE')

    for (let i = 0; i < 60; i++) {
      if (b.amendments.length > 0) break
      await scheduler.wait(1)
    }
    // Removing the undo window removed the thing that stopped a player rewriting an old round.
    // Being told is what replaces it, so this is the check rather than a nicety.
    expect(b.amendments.at(-1)).toMatchObject({
      type: 'RESULT_AMENDED',
      roundIndex: 0,
      outcome: 'TIE',
      by: 'A',
    })
  })

  it('brings back a round that stopWhenDecided had skipped', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    // 2-0 after two rounds: round 2 is a dead rubber and never played.
    await playToCompletion(a, b, ['A', 'A', 'A'])
    expect(a.view.rounds[2]?.result).toBeNull()
    expect(a.view.outcome).toBe('A')

    // Correcting round 0 makes it 1-1, so round 2 is suddenly live again.
    await amend(b, 0, 'B')

    expect(a.view.status).toBe('IN_PROGRESS')
    expect(a.view.outcome).toBeNull()
    // And the match is genuinely playable from there rather than merely un-completed.
    expect(a.view.phase?.roundIndex).toBe(2)
    await playToCompletion(a, b, ['B', 'A', 'A'])
    expect(a.view.rounds[2]?.result).not.toBeNull()
  })

  it('refuses an amendment attributed to the other seat', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await playToCompletion(a, b, ['A', 'B', 'A'])

    a.send({
      type: 'ACTION',
      idempotencyKey: crypto.randomUUID(),
      payload: { type: 'AMEND_RESULT', roundIndex: 0, outcome: 'B', amendedBy: 'B' },
    })
    expect((await a.waitForError()).code).toBe('NOT_YOUR_SEAT')
    expect(a.view.rounds[0]?.result).toBe('A')
  })

  it('refuses a tie in overtime, which exists to break one', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await playToCompletion(a, b, ['TIE', 'TIE', 'TIE', 'A'])
    expect(a.view.rounds[3]?.result).toBe('A')

    a.send({
      type: 'ACTION',
      idempotencyKey: crypto.randomUUID(),
      payload: { type: 'AMEND_RESULT', roundIndex: 3, outcome: 'TIE', amendedBy: 'A' },
    })
    // D30's round forbids ties, and the amendment has to respect the round's own rule rather
    // than assume every round takes the same three answers.
    expect((await a.waitForRejection()).code).toBe('ILLEGAL_OPTION')
    expect(a.view.rounds[3]?.result).toBe('A')
  })
})

describe('the leaderboard follows the correction', () => {
  it('records the corrected winner rather than both', async () => {
    const players: [string, string] = ['am-1', 'am-2']
    const { a, b, roomCode } = await seatedMatch({ modeId: 'base', draftCount: 4, players })
    await playToCompletion(a, b, ['A', 'B', 'A'])
    await amend(a, 0, 'B')
    await a.settle(40)

    for (let i = 0; i < 80; i++) {
      const response = await SELF.fetch('https://example.com/api/head-to-head?a=am-1&b=am-2')
      const record = (await response.json()) as { wins: number; losses: number; matches: unknown[] }
      // D29 upserts by room code and derives totals, which is exactly what makes this work: one
      // match, the second winner. A counter would have recorded both.
      if (record.matches.length === 1 && record.losses === 1) {
        expect(record.wins).toBe(0)
        expect(roomCode).toBeTruthy()
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the corrected result never reached the record')
  })
})
