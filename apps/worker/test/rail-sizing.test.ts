/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'

import { commitPhase, materialize, seatedMatch } from './client.js'

/**
 * What the rail can know, and when.
 *
 * The draft rail draws a box per slot from the moment the match opens, which means it needs a
 * count before anything is committed. These pin the three facts it relies on — all of them
 * subtle, and one of them (the empty-vs-absent distinction) is what made an earlier version of
 * the rail draw nothing at all through the entire draft.
 */

describe('the rail can size itself from the wire', () => {
  it('carries draftCount publicly, before anyone commits', async () => {
    // `slotCount` is derived from committed slots and so is 0 for the whole draft. The ruleset is
    // where the real number lives — public because the joiner consented to it in the lobby (§12.3).
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    for (const c of [a, b]) {
      expect(Number(c.view.ruleset.parameters.draftCount)).toBe(4)
      expect(c.view.opponent.slotCount).toBe(0)
    }
  })

  it('starts slots as an empty array, not as absent', async () => {
    // **The distinction that matters.** Slots begin as a *public empty slice* — visible, and
    // holding nothing. "Absent" means sealed, and that only happens once a commit lands. A client
    // that treats presence as "revealed" therefore takes the revealed path with an empty array
    // and renders zero boxes, which is precisely the blank draft the rail exists to fix.
    const { a } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    expect(a.view.opponent.slots).toEqual([])
    expect(a.view.you.slots).toEqual([])
  })

  it('goes absent once they commit, and stays absent until the reveal', async () => {
    const { a, b } = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    await commitPhase(a, b) // past the ban phase, into the draft
    await b.act(materialize(b.action('COMMIT')!, 'B'))
    await a.settle(10)

    // Now sealed: the array is gone entirely rather than emptied or flagged (§7).
    expect(a.view.opponent.slots).toBeUndefined()
    expect(a.view.opponent.hasCommitted).toBe(true)
    // And the count is public, so the rail can draw four sealed boxes without knowing what is in
    // them — which is what makes "waiting for opponent" renderable.
    expect(a.view.opponent.slotCount).toBe(4)
  })
})
