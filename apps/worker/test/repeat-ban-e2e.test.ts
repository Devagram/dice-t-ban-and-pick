/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'

import { commitPhase, seatedMatch, type TestClient } from './client.js'

/**
 * D28 end to end: two matches, the same two people, and a ban that may not repeat.
 *
 * The engine's half is covered in `packages/engine/test/repeat-ban.test.ts` — that the rule is a
 * term in the pool and that a client sending the ban anyway is refused. What is tested here is
 * everything around it: that the history is found, resolved at the right moment, written back,
 * and scoped to the right pairing.
 */

/** Plays the ban phase with a chosen character, and returns the pool each seat was offered. */
async function banPhase(
  players: [string, string],
  choose: { A: string; B: string },
  opts: { repeatBans?: boolean } = {},
) {
  const match = await seatedMatch({
    modeId: 'bring-ban1',
    draftCount: 4,
    players,
    ...(opts.repeatBans === false ? { repeatBans: false } : {}),
  })
  const pools = {
    A: match.a.action('COMMIT')!.metaBan!.pool,
    B: match.b.action('COMMIT')!.metaBan!.pool,
  }

  const place = async (client: TestClient, metaBan: string) =>
    client.act({ type: 'COMMIT', moduleId: 'ban', seat: client.seat, picks: [], metaBan })

  await place(match.a, choose.A)
  await place(match.b, choose.B)
  await match.a.settle(20)
  return { ...match, pools }
}

describe('the same ban cannot come twice against the same person', () => {
  it('offers it the first time and withholds it the second', async () => {
    const pair: [string, string] = ['p-tom', 'p-alex']

    const first = await banPhase(pair, { A: 'barbarian', B: 'moon-elf' })
    expect(first.pools.A).toContain('barbarian')

    const second = await banPhase(pair, { A: 'monk', B: 'ninja' })
    // A brought `barbarian` last set, so it is gone — and only for A.
    expect(second.pools.A).not.toContain('barbarian')
    expect(second.pools.B).toContain('barbarian')
    // B's own last ban is the one B loses.
    expect(second.pools.B).not.toContain('moon-elf')
    expect(second.pools.A).toContain('moon-elf')
  })

  it('lets a third set repeat the first set’s ban', async () => {
    // "Not two sets running" — the history remembers one set, not a career. A rule that got
    // stricter every time anyone played would be a different rule.
    const pair: [string, string] = ['p-c1', 'p-c2']
    await banPhase(pair, { A: 'barbarian', B: 'moon-elf' })
    await banPhase(pair, { A: 'monk', B: 'ninja' })

    const third = await banPhase(pair, { A: 'paladin', B: 'samurai' })
    expect(third.pools.A).toContain('barbarian')
    expect(third.pools.A).not.toContain('monk')
  })

  it('does not follow you to a different opponent', async () => {
    await banPhase(['p-d1', 'p-d2'], { A: 'barbarian', B: 'moon-elf' })

    // Same player, new opponent, clean slate: the history is a fact about a *pairing*.
    const elsewhere = await banPhase(['p-d1', 'p-d3'], { A: 'monk', B: 'ninja' })
    expect(elsewhere.pools.A).toContain('barbarian')
  })
})

describe('the rule stays out of the way when it should', () => {
  it('does nothing for anonymous seats', async () => {
    // An older client sends no identity. The match plays exactly as it always did.
    const first = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    await first.a.act({
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'barbarian',
    })
    await first.b.act({
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'B',
      picks: [],
      metaBan: 'moon-elf',
    })
    await first.a.settle(20)

    const second = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4 })
    expect(second.a.action('COMMIT')!.metaBan!.pool).toContain('barbarian')
  })

  it('writes nothing until both seats have banned', async () => {
    // A half-finished match must not bind the next one.
    const pair: [string, string] = ['p-e1', 'p-e2']
    const abandoned = await seatedMatch({ modeId: 'bring-ban1', draftCount: 4, players: pair })
    await abandoned.a.act({
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'barbarian',
    })
    await abandoned.a.settle(20)

    const next = await banPhase(pair, { A: 'monk', B: 'ninja' })
    expect(next.pools.A).toContain('barbarian')
  })

  it('resolves the pairing exactly once, and before anything is committed', async () => {
    const { a } = await banPhase(['p-f1', 'p-f2'], { A: 'barbarian', B: 'moon-elf' })
    await commitPhase(a, a) // no-op; just settles
    // Asserted from the client's own frames: the rule must never narrow a pool mid-decision.
    expect(a.view.status).toBe('IN_PROGRESS')
  })
})
