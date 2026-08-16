import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch } from './client.js'

/**
 * **D36 — the Bo1 played end to end in workerd.**
 *
 * The engine tests prove the rules; this proves the mode survives the parts a pure test cannot
 * reach — the create endpoint, the variant lookup for a mode with no parameters, the wire
 * protocol, and the recorded result. The seal is asserted on the **frames** rather than on a
 * projection, because a redaction that holds in `project` and leaks in what the socket sends is
 * the failure §7 is actually about.
 */

const bo1 = () => seatedMatch({ modeId: 'bo1-bring3-ban1' })

describe('the lobby offers it', () => {
  it('lists the mode with no parameters to choose', async () => {
    const modes = (await (await SELF.fetch('https://example.com/api/modes')).json()) as {
      modeId: string
      label: string
      parameters: Record<string, unknown>
    }[]

    const mode = modes.find((m) => m.modeId === 'bo1-bring3-ban1')
    expect(mode).toBeTruthy()
    expect(mode!.label).toBe('Bo1 — bring 3, ban 1')
    // Nothing for the host to set: three brought is the format, not a setting.
    expect(Object.keys(mode!.parameters)).toEqual([])
  })

  it('creates a match without being handed a draftCount', async () => {
    const response = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeId: 'bo1-bring3-ban1', parameters: {}, globalBanned: [] }),
    })
    // 201 — creation makes a room, and the endpoint says so.
    expect(response.status).toBe(201)
  })
})

describe('a whole Bo1 over the wire', () => {
  it('plays one round and completes', async () => {
    const { a, b } = await bo1()
    await playToCompletion(a, b, ['A'])

    expect(a.view.status).toBe('COMPLETE')
    expect(a.view.outcome).toBe('A')
    // One round, not three with two blanks — the thing the round-count constant used to get wrong.
    expect(a.view.rounds).toHaveLength(1)
    expect(b.view.rounds).toHaveLength(1)
  })

  it('brings three each and spends exactly one', async () => {
    const { a, b } = await bo1()
    await playToCompletion(a, b, ['A'])

    for (const client of [a, b]) {
      expect(client.view.you.slots).toHaveLength(3)
      expect(client.view.you.slots!.filter((s) => s.consumed)).toHaveLength(1)
      // One of the other two is the opponent's ban; the third was simply not chosen.
      expect(client.view.you.slots!.filter((s) => s.bannedInRound === 0)).toHaveLength(1)
    }
  })

  it('records a drawn Bo1 as a draw rather than reaching for a decider', async () => {
    const { a, b } = await bo1()
    await playToCompletion(a, b, ['TIE'])

    expect(a.view.status).toBe('COMPLETE')
    expect(a.view.outcome).toBe('DRAW')
    expect(a.view.you.score).toBe(0.5)
    expect(b.view.you.score).toBe(0.5)
  })
})

describe('the simultaneous ban on the wire', () => {
  it('never sends a seat the ban placed against it before both are in', async () => {
    const { a, b } = await bo1()

    // Through the draft and its reveal, to the ban.
    for (const client of [a, b]) {
      const commit = client.action('COMMIT')
      if (commit) {
        await client.act({
          type: 'COMMIT',
          moduleId: commit.moduleId,
          seat: client.seat,
          picks: (commit.picks?.poolBySlot ?? []).reduce<string[]>((picked, pool) => {
            const choice = pool.find((id) => !picked.includes(id))!
            return [...picked, choice]
          }, []),
          metaBan: null,
        })
      }
    }
    await a.settle(10)

    const ban = a.action('BAN')
    expect(ban, 'A should be asked to ban').toBeTruthy()
    const target = ban!.targets[0]!
    const framesBefore = b.frames.length

    await a.act({
      type: 'BAN',
      moduleId: ban!.moduleId,
      roundIndex: ban!.roundIndex,
      seat: 'A',
      tier: 'ROUND',
      target,
    })
    await b.settle(10)

    /*
     * Asserted on the raw frames, which is the §7 rule: "the client must never receive a redacted
     * value with a flag; it must receive nothing." An object-level check passes while a `toJSON`
     * leaks, and here the leak would not even be in the `ban` field — it would be `bannedInRound`
     * on B's own slot, which B is otherwise entitled to see.
     */
    const sinceBan = b.frames.slice(framesBefore).join('')
    expect(sinceBan).not.toContain('"bannedInRound":0')

    // B is still asked for its own ban, and still has all three of A's slots to choose from.
    expect(b.action('BAN')?.targets).toHaveLength(3)
    // And B can see *that* A has banned, which is what makes the wait explainable.
    expect(b.view.rounds[0]!.banCommitted.A).toBe(true)
  })
})
