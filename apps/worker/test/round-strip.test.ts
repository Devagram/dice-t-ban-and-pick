/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'

import { commitPhase, seatedMatch } from './client.js'

/**
 * When the game actually starts, as the wire reports it.
 *
 * The client hides its R1/R2/R3 strip until the rounds begin, and decides that from
 * `phase.roundIndex` alone — null through every pre-round module, a number from the first roll
 * on. That is the whole basis for the guard in `RoundStrip`, and it is a property of the
 * projection rather than of the client, so it belongs here.
 */

describe('phase.roundIndex says whether the game has begun', () => {
  it('is null through the ban and the draft, and set once a round opens', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })

    expect(a.view.phase?.moduleId).toBe('ban')
    expect(a.view.phase?.roundIndex).toBeNull()

    await commitPhase(a, b) // bans in, and revealed
    expect(a.view.phase?.moduleId).toBe('draft')
    expect(a.view.phase?.roundIndex).toBeNull()

    await commitPhase(a, b) // drafts in, picks revealed, round one opens
    expect(a.view.phase?.roundIndex).toBe(0)
    expect(a.view.phase?.moduleId).toContain('rounds.0.')
  })

  it('reports the same to both seats', async () => {
    // The strip is public information — nothing about it is per-seat, so a discrepancy would
    // mean two players disagreeing about whether the match had started.
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    expect(a.view.phase?.roundIndex).toBe(b.view.phase?.roundIndex)
    await commitPhase(a, b)
    await commitPhase(a, b)
    expect(a.view.phase?.roundIndex).toBe(b.view.phase?.roundIndex)
  })

  it('starts at round zero in base mode too, where there is no ban phase', async () => {
    const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    expect(a.view.phase?.roundIndex).toBeNull()
    await commitPhase(a, b)
    expect(a.view.phase?.roundIndex).toBe(0)
  })
})
