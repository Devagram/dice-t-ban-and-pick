/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'

import { materialize, seatedMatch } from './client.js'

/**
 * The two reveal gates, as the rail sees them.
 *
 * `bring-ban1` is deliberately not one reveal but two: both seats commit picks *and* a meta ban
 * blind, the **bans** open first, the repick happens against that knowledge, and only then do the
 * picks open. The middle state is the interesting one and the easiest to render wrong — bans
 * public while picks are still sealed — because it is the only moment where one slice of a seat
 * is visible and another is not.
 */

describe('gate one opens the bans and nothing else', () => {
  it('shows what they banned while their picks stay sealed', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    await a.act(materialize(a.action('COMMIT')!, 'A'))
    await b.act(materialize(b.action('COMMIT')!, 'B'))
    await a.settle(20)

    // Gate one: the ban is out in the open...
    expect(a.view.opponent.metaBanPlaced).toBeDefined()
    expect(typeof a.view.opponent.metaBanPlaced).toBe('string')
    // ...and the draft behind it is not.
    expect(a.view.opponent.slots).toBeUndefined()
    expect(a.view.opponent.hasCommitted).toBe(true)
    expect(a.view.opponent.slotCount).toBe(4)
  })

  it('does not leak their picks in the frame that carries the ban', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    const bPicks = materialize(b.action('COMMIT')!, 'B')
    await a.act(materialize(a.action('COMMIT')!, 'A'))
    await b.act(bPicks)
    await a.settle(20)

    // Scoped to B's own payload, and asserted on the **serialized** form — an object check
    // passes while a `toJSON` leaks. Not scoped to the whole frame: `view.roster` is public and
    // names every character in the game, so a frame-wide search matches on the roster and proves
    // nothing either way.
    const ids = 'picks' in bPicks ? (bPicks.picks as string[]) : []
    expect(ids.length).toBeGreaterThan(0)

    const opponent = JSON.stringify(a.view.opponent)
    const banned = a.view.opponent.metaBanPlaced
    expect(opponent).toContain(String(banned)) // the ban is there, so the search is live
    for (const id of ids) {
      if (id === banned) continue // a banned character is public by definition at gate one
      expect(opponent, `gate one leaked B's pick "${id}"`).not.toContain(`"${id}"`)
    }
  })
})
