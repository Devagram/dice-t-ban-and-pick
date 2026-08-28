/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import type { StatsPage } from '../src/RegistryDO.js'

/**
 * **D50 — the fun ones.**
 *
 * Counts rather than judgements, which is what makes them testable: every figure here is a
 * property of the stored rows, and the tests worth having are about counting the right thing on
 * the right side. "Banned against" in particular is a fact about the person who was banned and it
 * would be trivially easy to file it under the person who typed it.
 */

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName(crypto.randomUUID()))

interface Side {
  drafted?: string[]
  played?: string[]
  metaBan?: string | null
  /** D45 — which hero played which round. */
  lineup?: (string | null)[]
  /** D51 — the character this seat's round ban denied, per round. */
  roundBans?: (string | null)[]
}

function seed(
  stub: DurableObjectStub,
  roomCode: string,
  match: {
    a?: string
    b?: string
    A: Side
    B: Side
    rounds?: (string | null)[]
    /** D51 — which seat chose first, per round; `null` where the round was blind. */
    firstToSelect?: (string | null)[]
    /** D51 — the mode it was played under. */
    modeId?: string
  },
) {
  const side = (s: Side) => ({
    drafted: s.drafted ?? (s.lineup ? [...new Set(s.lineup.filter(Boolean))] : []),
    played: s.played ?? s.drafted ?? (s.lineup ? [...new Set(s.lineup.filter(Boolean))] : []),
    metaBan: s.metaBan ?? null,
    ...(s.lineup ? { lineup: s.lineup } : {}),
    ...(s.roundBans ? { roundBans: s.roundBans } : {}),
  })
  return stub.fetch('https://r/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomCode,
      playedAt: 1,
      a: { id: match.a ?? 'p-tom', name: match.a === 'p-alex' ? 'Alex' : 'Tom' },
      b: { id: match.b ?? 'p-alex', name: match.b === 'p-tom' ? 'Tom' : 'Alex' },
      winnerId: match.a ?? 'p-tom',
      scoreA: 2,
      scoreB: 1,
      detail: {
        rounds: match.rounds ?? ['A'],
        ...(match.firstToSelect ? { firstToSelect: match.firstToSelect } : {}),
        ...(match.modeId ? { modeId: match.modeId } : {}),
        seats: { A: side(match.A), B: side(match.B) },
      },
    }),
  })
}

const stats = async (stub: DurableObjectStub): Promise<StatsPage> =>
  (await (await stub.fetch('https://r/stats')).json()) as StatsPage

const names = (counts: { characterId: string; count: number }[]) =>
  counts.map((c) => `${c.characterId}:${c.count}`)

describe('what everybody brings', () => {
  it('counts a draft once per seat that drafted it', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { drafted: ['thor', 'loki'] }, B: { drafted: ['thor', 'ninja'] } })
    await seed(r, 'R2', { A: { drafted: ['thor'] }, B: { drafted: ['loki'] } })

    const page = await stats(r)
    expect(names(page.picked)).toEqual(['thor:3', 'loki:2', 'ninja:1'])
    expect(page.matches).toBe(2)
  })

  it('separates what was drafted from what actually reached the table', async () => {
    const r = registry()
    await seed(r, 'R1', {
      A: { drafted: ['thor', 'loki', 'santa'], played: ['thor'] },
      B: { drafted: ['ninja'], played: ['ninja'] },
    })

    const page = await stats(r)
    // Drafted and never reached is the other half of what a pick meant, and a different question
    // from what got played.
    expect(names(page.played)).toEqual(['ninja:1', 'thor:1'])
    expect(names(page.benched)).toEqual(['loki:1', 'santa:1'])
  })

  it('counts a mirror once for the match, not once per seat', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { drafted: ['thor', 'loki'] }, B: { drafted: ['thor', 'ninja'] } })

    // §15 asks for the frequency of mirror drafts: the fact is "both brought it to this match",
    // which is one occurrence however many seats it took.
    expect(names((await stats(r)).mirrored)).toEqual(['thor:1'])
  })
})

describe('who everybody bans', () => {
  it('counts the meta ban as a strike against the hero named', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { metaBan: 'thor' }, B: { metaBan: 'loki' } })
    await seed(r, 'R2', { A: { metaBan: 'thor' }, B: { metaBan: null } })

    expect(names((await stats(r)).banned)).toEqual(['thor:2', 'loki:1'])
  })

  it('counts a steal — banned off somebody, then drafted by the banner', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { drafted: ['thor'], metaBan: 'thor' }, B: { drafted: ['ninja'] } })
    await seed(r, 'R2', { A: { drafted: ['loki'], metaBan: 'thor' }, B: { drafted: ['ninja'] } })

    /*
     * D4 scopes a ban to the opponent rather than removing the character from the match, so
     * banning one and then playing it is legal — `bring-ban1`'s notes call it the steal. Only the
     * first match is one; the second banned Thor and brought somebody else.
     */
    expect(names((await stats(r)).stolen)).toEqual(['thor:1'])
  })
})

describe('by player', () => {
  it('files a ban under the player it was aimed at, not the one who typed it', async () => {
    const r = registry()
    await seed(r, 'R1', {
      a: 'p-tom',
      b: 'p-alex',
      A: { drafted: ['thor'], metaBan: 'ninja' },
      B: { drafted: ['ninja'], metaBan: 'thor' },
    })

    const page = await stats(r)
    const tom = page.players.find((p) => p.playerId === 'p-tom')!
    const alex = page.players.find((p) => p.playerId === 'p-alex')!

    // Tom banned Ninja; what Tom is *known for* is what Alex banned against him.
    expect(names(tom.banned)).toEqual(['ninja:1'])
    expect(names(tom.bannedAgainst)).toEqual(['thor:1'])
    expect(names(alex.banned)).toEqual(['thor:1'])
    expect(names(alex.bannedAgainst)).toEqual(['ninja:1'])
  })

  it('counts what each player drafts, whichever seat they sat in', async () => {
    const r = registry()
    await seed(r, 'R1', {
      a: 'p-tom',
      b: 'p-alex',
      A: { drafted: ['thor'] },
      B: { drafted: ['loki'] },
    })
    // The same two players, seats swapped — a habit is a habit whichever side of the table it is on.
    await seed(r, 'R2', {
      a: 'p-alex',
      b: 'p-tom',
      A: { drafted: ['loki'] },
      B: { drafted: ['thor'] },
    })

    const page = await stats(r)
    expect(names(page.players.find((p) => p.playerId === 'p-tom')!.picked)).toEqual(['thor:2'])
    expect(names(page.players.find((p) => p.playerId === 'p-alex')!.picked)).toEqual(['loki:2'])
  })

  it('orders players by how much they have played', async () => {
    const r = registry()
    await seed(r, 'R1', { a: 'p-tom', b: 'p-alex', A: {}, B: {} })
    await seed(r, 'R2', { a: 'p-tom', b: 'p-sam', A: {}, B: {} })

    // The page is read top-down and the regulars are who anybody is looking for.
    expect((await stats(r)).players[0]).toMatchObject({ playerId: 'p-tom', matches: 2 })
  })
})

describe('the counting itself', () => {
  it('is derived, so a deleted match stops counting', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { drafted: ['thor'], metaBan: 'ninja' }, B: { drafted: ['ninja'] } })
    expect(names((await stats(r)).banned)).toEqual(['ninja:1'])

    await r.fetch('https://r/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomCode: 'R1' }),
    })

    const page = await stats(r)
    expect(page.matches).toBe(0)
    expect(page.banned).toEqual([])
    expect(page.players).toEqual([])
  })

  it('holds a total order, so two reads agree', async () => {
    const r = registry()
    // Three heroes on the same count: without a tiebreak the page could reorder between reads.
    await seed(r, 'R1', { A: { drafted: ['thor', 'loki', 'ninja'] }, B: {} })

    expect(names((await stats(r)).picked)).toEqual(names((await stats(r)).picked))
    expect(names((await stats(r)).picked)).toEqual(['loki:1', 'ninja:1', 'thor:1'])
  })

  it('answers on an empty deployment rather than failing', async () => {
    const page = await stats(registry())
    expect(page).toMatchObject({ matches: 0, picked: [], banned: [], players: [] })
  })

  it('survives a match with no detail at all', async () => {
    const r = registry()
    await r.fetch('https://r/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomCode: 'R1',
        playedAt: 1,
        a: { id: 'p-tom', name: 'Tom' },
        b: { id: 'p-alex', name: 'Alex' },
        winnerId: 'p-tom',
        scoreA: 1,
        scoreB: 0,
        detail: null,
      }),
    })

    // A D44 hand-added match can hold a result and nothing else. It contributes no habits and
    // must not take the page down with it.
    const page = await stats(r)
    expect(page.matches).toBe(0)
    expect(page.picked).toEqual([])
  })
})

/**
 * **D51 — the gaps the record started closing.**
 *
 * Three facts the match knew and never wrote down: the round ban, which seat chose first, and
 * which mode was played. Each of them blocked a figure somebody asked for, and each is only
 * answerable from matches recorded since — the same shape D45 had, and reported the same way.
 */
describe('the round ban, counted apart from the meta ban', () => {
  it('counts a denial per round, not per match', async () => {
    const r = registry()
    await seed(r, 'R1', {
      A: { drafted: ['thor'], metaBan: 'krampus', roundBans: ['ninja', 'ninja', null] },
      B: { drafted: ['ninja'], roundBans: ['thor', null, null] },
    })

    const page = await stats(r)
    // Three round bans in a match to the meta ban's one, which is why adding them together would
    // answer neither question.
    expect(names(page.denied)).toEqual(['ninja:2', 'thor:1'])
    expect(names(page.banned)).toEqual(['krampus:1'])
  })

  it('is empty on a record from before it was kept', async () => {
    const r = registry()
    await seed(r, 'R1', { A: { drafted: ['thor'], metaBan: 'ninja' }, B: { drafted: ['ninja'] } })

    // No guessing: a round ban that was never written down did not happen as far as this can say.
    expect((await stats(r)).denied).toEqual([])
  })
})

describe('the counter-pick', () => {
  it('credits the seat that chose second, and the one it was chosen against', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A', 'B'],
      firstToSelect: ['A', 'B'],
      A: { lineup: ['thor', 'loki'] },
      B: { lineup: ['ninja', 'druid'] },
    })

    const page = await stats(r)
    /*
     * Round one: A chose Thor, then B answered with Ninja. Round two: B chose Druid first and A
     * answered with Loki. The counter-pick is the second one — the choice made knowing.
     */
    expect(names(page.counterPicked)).toEqual(['loki:1', 'ninja:1'])
    expect(names(page.answered)).toEqual(['druid:1', 'thor:1'])
    expect(page.sequentialRounds).toBe(2)
  })

  it('counts nothing from a blind round, where nobody countered anybody', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A', 'A'],
      // `null` is a simultaneous round: both seats committed without seeing, so the order the two
      // events arrived in is an accident of the network rather than a decision.
      firstToSelect: ['A', null],
      A: { lineup: ['thor', 'loki'] },
      B: { lineup: ['ninja', 'druid'] },
    })

    const page = await stats(r)
    expect(names(page.counterPicked)).toEqual(['ninja:1'])
    expect(page.sequentialRounds).toBe(1)
  })

  it('counts nothing at all from a record kept before the order was', async () => {
    const r = registry()
    await seed(r, 'R1', { rounds: ['A'], A: { lineup: ['thor'] }, B: { lineup: ['ninja'] } })

    // The figure the page uses to say "still filling up" rather than showing an empty card that
    // looks like a bug.
    const page = await stats(r)
    expect(page.sequentialRounds).toBe(0)
    expect(page.counterPicked).toEqual([])
  })

  it('composes with the deduction: an order is not enough without a hero', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A', 'B'],
      firstToSelect: ['A', 'B'],
      // A split with no lineup. D47 will not say which hero played which round of one — so the
      // order is known, the heroes are not, and a counter-pick needs both.
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'] },
    })

    const page = await stats(r)
    expect(page.counterPicked).toEqual([])
    expect(page.sequentialRounds).toBe(0)
  })

  it('composes the other way: a deduced sweep with an order still counts', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A'],
      firstToSelect: ['A'],
      // One decided round: D47 settles both heroes from `played` alone, and D51 says who chose
      // second. Neither mechanism needs the other to have been there first.
      A: { drafted: ['thor'], played: ['thor'] },
      B: { drafted: ['ninja'], played: ['ninja'] },
    })

    const page = await stats(r)
    expect(names(page.counterPicked)).toEqual(['ninja:1'])
    expect(names(page.answered)).toEqual(['thor:1'])
  })
})

describe('the mode', () => {
  it('is reported on a hero’s games when the record knows it', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A'],
      modeId: 'bring-ban1',
      A: { lineup: ['thor'] },
      B: { lineup: ['ninja'] },
    })

    const detail = (await (await r.fetch('https://r/hero?id=thor')).json()) as {
      appearances: { modeId?: string; format: string }[]
    }
    // Named rather than inferred. The inference stays for the rows recorded before this.
    expect(detail.appearances[0]).toMatchObject({ modeId: 'bring-ban1', format: 'Bo1' })
  })

  it('falls back to the shape the round count implies', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A', 'B', 'A', null],
      A: { lineup: ['thor', 'thor', 'thor', null] },
      B: { lineup: ['ninja', 'ninja', 'ninja', null] },
    })

    const detail = (await (await r.fetch('https://r/hero?id=thor')).json()) as {
      appearances: { modeId?: string; format: string }[]
    }
    // Four slots is a Bo3 with overtime, which is exact for every mode shipped so far — and a
    // claim the page marks as inferred rather than passing off as the mode's name.
    expect(detail.appearances[0]!.format).toBe('Bo3')
    expect(detail.appearances[0]!.modeId).toBeUndefined()
  })
})
