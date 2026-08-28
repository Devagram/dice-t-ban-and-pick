/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env, SELF } from 'cloudflare:test'

import type { HeroStanding } from '../src/RegistryDO.js'
import { playToCompletion, seatedMatch } from './client.js'

/**
 * **D45 — the stored matches, counted by hero.**
 *
 * A round is one hero against one hero, so a round is where a hero's record lives. Everything
 * below is about that attribution being honest in the two directions it can fail: crediting a
 * round to the hero that was actually on the table for it, and refusing to credit one at all when
 * the record cannot say who was.
 *
 * Seeded straight into a fresh registry rather than played out over a socket. A played match
 * cannot tell this test *which* hero it drafted into round two without reading the same state the
 * code under test reads, and an assertion that computes its own expected answer from the
 * implementation is not an assertion.
 */

const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName(crypto.randomUUID()))

type Outcome = 'A' | 'B' | 'TIE' | null

/**
 * One stored match. `lineup` is what D45 added: which hero each seat had on the table for each
 * round, indexed to match `rounds` exactly.
 */
function seed(
  stub: DurableObjectStub,
  roomCode: string,
  detail: {
    rounds: Outcome[]
    A: { drafted?: string[]; played?: string[]; lineup?: (string | null)[] }
    B: { drafted?: string[]; played?: string[]; lineup?: (string | null)[] }
  },
) {
  const side = (s: { drafted?: string[]; played?: string[]; lineup?: (string | null)[] }) => ({
    drafted: s.drafted ?? [...new Set((s.lineup ?? []).filter((c): c is string => c !== null))],
    played: s.played ?? [...new Set((s.lineup ?? []).filter((c): c is string => c !== null))],
    metaBan: null,
    ...(s.lineup ? { lineup: s.lineup } : {}),
  })

  return stub.fetch('https://r/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomCode,
      playedAt: 1,
      a: { id: 'p-a', name: 'Tom' },
      b: { id: 'p-b', name: 'Alex' },
      winnerId: 'p-a',
      scoreA: 2,
      scoreB: 1,
      detail: { rounds: detail.rounds, seats: { A: side(detail.A), B: side(detail.B) } },
    }),
  })
}

/** The public history, once the match object has filed its result. */
async function matchesSettle(min: number, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const body = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
      matches: { roomCode: string; detail: unknown }[]
    }
    if (body.matches.length >= min) return body.matches
    await scheduler.wait(1)
  }
  throw new Error(`fewer than ${min} matches ever reached the history`)
}

async function board(stub: DurableObjectStub) {
  const body = (await (await stub.fetch('https://r/heroes')).json()) as {
    heroes: HeroStanding[]
    unattributedRounds: number
  }
  return {
    ...body,
    of: (characterId: string) => body.heroes.find((h) => h.characterId === characterId),
    order: body.heroes.map((h) => h.characterId),
  }
}

describe('a hero is credited with the rounds it played', () => {
  it('splits one match between the heroes that were on the table for each round', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'B', 'TIE'],
      A: { lineup: ['thor', 'loki', 'thor'] },
      B: { lineup: ['ninja', 'druid', 'santa'] },
    })

    const heroes = await board(r)
    // Thor won round one and drew round three; Loki lost the round it was actually in. Before
    // D45 all three of A's rounds were one undifferentiated "Tom won 2–1".
    expect(heroes.of('thor')).toMatchObject({ wins: 1, losses: 0, draws: 1 })
    expect(heroes.of('loki')).toMatchObject({ wins: 0, losses: 1, draws: 0 })
    // And the other seat's side of the same three rounds.
    expect(heroes.of('ninja')).toMatchObject({ wins: 0, losses: 1, draws: 0 })
    expect(heroes.of('druid')).toMatchObject({ wins: 1, losses: 0, draws: 0 })
    expect(heroes.of('santa')).toMatchObject({ wins: 0, losses: 0, draws: 1 })
    expect(heroes.unattributedRounds).toBe(0)
  })

  it('credits nobody for a round nobody played', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A', null],
      A: { lineup: ['thor', 'loki', null] },
      B: { lineup: ['ninja', 'druid', null] },
    })

    const heroes = await board(r)
    // `stopWhenDecided` ends a 2–0 Bo3 early. That third round is a real state, not missing
    // data, and it is not a result for anybody — including the tally of what cannot be credited.
    expect(heroes.of('thor')).toMatchObject({ wins: 1, losses: 0, draws: 0 })
    expect(heroes.unattributedRounds).toBe(0)
    expect(heroes.heroes.every((h) => h.wins + h.losses + h.draws <= 2)).toBe(true)
  })

  it('gives a mirror round to the same hero on both sides of itself', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'TIE'],
      A: { lineup: ['thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['thor', 'thor'], drafted: ['thor'], played: ['thor'] },
    })

    const heroes = await board(r)
    /*
     * D1 allows cross-seat mirrors, so a round can be Thor against Thor. It won that round and it
     * lost it; the tie is two draws. Anything else would have to decide which copy was "the" Thor,
     * and there is no such fact.
     */
    expect(heroes.of('thor')).toMatchObject({ wins: 1, losses: 1, draws: 2, drafted: 2 })
  })

  it('counts a hero once per round it played, not once per match', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'B', 'A'],
      A: { lineup: ['thor', 'thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['ninja', 'ninja', 'ninja'], drafted: ['ninja'], played: ['ninja'] },
    })

    const heroes = await board(r)
    // A mode can play the same hero every round. Three rounds is three results.
    expect(heroes.of('thor')).toMatchObject({ wins: 2, losses: 1, draws: 0, drafted: 1, played: 1 })
  })
})

describe('rounds the record cannot attribute', () => {
  /** The shape D29 stored: which heroes were brought and used, in slot order — never which round. */
  const legacy = (stub: DurableObjectStub) =>
    seed(stub, 'OLD001', {
      rounds: ['A', 'B', 'A'],
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja'] },
    })

  it('counts them as uncredited rather than dropping them silently', async () => {
    const r = registry()
    await legacy(r)

    const heroes = await board(r)
    // Three decisive rounds, none of them attributable — counted as three rather than as the six
    // hero-slots inside them, because "rounds" is the unit the screen reports and a doubled figure
    // would overstate the gap it is apologising for.
    expect(heroes.unattributedRounds).toBe(3)
    expect(heroes.heroes.every((h) => h.wins + h.losses + h.draws === 0)).toBe(true)
  })

  it('still counts what those records do say — drafted, and played', async () => {
    const r = registry()
    await legacy(r)

    const heroes = await board(r)
    // `drafted` and `played` have been stored since D29, so they reach back over the whole
    // archive. Only the outcome is missing, and only the outcome.
    expect(heroes.of('thor')).toMatchObject({ drafted: 1, played: 1, wins: 0 })
    // Drafted and never reached: the other half of what a pick meant.
    expect(heroes.of('druid')).toMatchObject({ drafted: 1, played: 0 })
  })

  it('mixes old and new records without letting one distort the other', async () => {
    const r = registry()
    await seed(r, 'OLD001', {
      rounds: ['A', 'B'],
      A: { drafted: ['thor'], played: ['thor'] },
      B: { drafted: ['ninja'], played: ['ninja'] },
    })
    await seed(r, 'NEW001', {
      rounds: ['A', 'A'],
      A: { lineup: ['thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['ninja', 'ninja'], drafted: ['ninja'], played: ['ninja'] },
    })

    const heroes = await board(r)
    // Thor: two matches drafted, two rounds credited from the newer one, and the older match's
    // two rounds credited to nobody.
    expect(heroes.of('thor')).toMatchObject({ drafted: 2, played: 2, wins: 2, losses: 0 })
    expect(heroes.unattributedRounds).toBe(2)
  })
})

describe('the order the board is in', () => {
  /** Two heroes with a real sample, and two with one round each. */
  const stack = async (stub: DurableObjectStub) => {
    for (const room of ['R1', 'R2']) {
      await seed(stub, room, {
        rounds: ['A', 'A', 'B'],
        A: { lineup: ['hot', 'hot', 'hot'], drafted: ['hot'], played: ['hot'] },
        B: { lineup: ['cold', 'cold', 'cold'], drafted: ['cold'], played: ['cold'] },
      })
    }
    await seed(stub, 'R3', {
      rounds: ['A'],
      A: { lineup: ['lucky'] },
      B: { lineup: ['unlucky'] },
    })
  }

  it('ranks on the rate whatever the sample behind it', async () => {
    const r = registry()
    await stack(r)
    const heroes = await board(r)

    /*
     * A minimum-rounds gate used to hold `lucky` — one round, all of it won — below `hot`, which
     * has won four of six. Removed on the owner's call: the record is on the row beside the rate,
     * so a 1–0–0 at the top reads as exactly what it is.
     */
    expect(heroes.order).toEqual(['lucky', 'hot', 'cold', 'unlucky'])
    expect(heroes.of('lucky')).toMatchObject({ wins: 1, losses: 0 })
    expect(heroes.of('hot')).toMatchObject({ wins: 4, losses: 2 })
  })

  it('breaks a tied rate on how much the hero has played', async () => {
    const r = registry()
    await stack(r)
    // `cold` won two of six; `unlucky` won none of one. Both are behind, and the one with a real
    // sample is the more meaningful row of the two.
    const order = (await board(r)).order
    expect(order.indexOf('cold')).toBeLessThan(order.indexOf('unlucky'))
  })

  it('is total, so two identical records do not swap places between reads', async () => {
    const r = registry()
    await stack(r)
    const first = (await board(r)).order
    const second = (await board(r)).order
    expect(second).toEqual(first)
  })
})

describe('the board is derived, never accumulated', () => {
  it('follows an edit to the match it was counted from', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A', 'A'],
      A: { lineup: ['thor', 'thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['ninja', 'ninja', 'ninja'], drafted: ['ninja'], played: ['ninja'] },
    })
    expect((await board(r)).of('thor')).toMatchObject({ wins: 3, losses: 0 })

    // The same room recorded again — D15 lets a finished match un-finish and complete differently,
    // and `record` upserts by room code. A counter would now say six.
    await seed(r, 'ROOM01', {
      rounds: ['B', 'B', 'B'],
      A: { lineup: ['thor', 'thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['ninja', 'ninja', 'ninja'], drafted: ['ninja'], played: ['ninja'] },
    })
    expect((await board(r)).of('thor')).toMatchObject({ wins: 0, losses: 3 })
  })

  it('empties when the matches do', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A'],
      A: { lineup: ['thor'] },
      B: { lineup: ['ninja'] },
    })
    await r.fetch('https://r/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomCode: 'ROOM01' }),
    })

    const heroes = await board(r)
    expect(heroes.heroes).toEqual([])
    expect(heroes.unattributedRounds).toBe(0)
  })
})

describe('who a hero beats, and who beats it', () => {
  /** `n` rounds of `hero` against `foe`, all won by whichever seat `winner` names. */
  const meetings = (
    stub: DurableObjectStub,
    room: string,
    hero: string,
    foe: string,
    rounds: Outcome[],
  ) =>
    seed(stub, room, {
      rounds,
      A: { lineup: rounds.map(() => hero), drafted: [hero], played: [hero] },
      B: { lineup: rounds.map(() => foe), drafted: [foe], played: [foe] },
    })

  it('ranks the opponents it is up on, furthest ahead first', async () => {
    const r = registry()
    await meetings(r, 'R1', 'thor', 'ninja', ['A', 'A', 'A'])
    await meetings(r, 'R2', 'thor', 'druid', ['A', 'B'])
    await meetings(r, 'R3', 'thor', 'loki', ['A', 'A', 'B'])

    const thor = (await board(r)).of('thor')!
    // +3 on Ninja, +1 on Loki, level with Druid. Ordered by the edge rather than by the rate, so
    // 3–0 outranks 2–1 without either having to be scored against a draw.
    expect(thor.best.map((m) => m.characterId)).toEqual(['ninja', 'loki'])
    expect(thor.best[0]).toMatchObject({ characterId: 'ninja', wins: 3, losses: 0, draws: 0 })
    expect(thor.worst).toEqual([])
  })

  it('leaves a level matchup out of both ends', async () => {
    const r = registry()
    await meetings(r, 'R1', 'thor', 'druid', ['A', 'B'])
    await meetings(r, 'R2', 'thor', 'santa', ['TIE', 'TIE'])

    const thor = (await board(r)).of('thor')!
    // 1–1 against Druid and 0–0–2 against Santa. Neither is a best or a worst matchup: they are
    // the ones still worth arguing about, and calling either one would be inventing a verdict.
    expect(thor.best).toEqual([])
    expect(thor.worst).toEqual([])
  })

  it('reads the same pairing from the other side', async () => {
    const r = registry()
    await meetings(r, 'R1', 'thor', 'ninja', ['A', 'A', 'B'])

    const heroes = await board(r)
    expect(heroes.of('thor')!.best).toMatchObject([{ characterId: 'ninja', wins: 2, losses: 1 }])
    // One set of rounds, two rows that cannot disagree — Ninja is down by exactly what Thor is up.
    expect(heroes.of('ninja')!.worst).toMatchObject([{ characterId: 'thor', wins: 1, losses: 2 }])
    expect(heroes.of('ninja')!.best).toEqual([])
  })

  it('counts a draw in the record without letting it decide the ranking', async () => {
    const r = registry()
    await meetings(r, 'R1', 'thor', 'ninja', ['A', 'TIE', 'TIE'])

    const thor = (await board(r)).of('thor')!
    // 1–0–2: up by one, whatever the draws do. Pricing a draw is the question D29 refused to
    // answer, and a matchup ranking does not have to ask it.
    expect(thor.best).toMatchObject([{ characterId: 'ninja', wins: 1, losses: 0, draws: 2 }])
  })

  it('names three at each end and no more', async () => {
    const r = registry()
    for (const [i, foe] of ['ninja', 'druid', 'santa', 'krampus'].entries()) {
      // Beaten by a different margin each time, so "the top three" is a fact rather than a tie.
      await meetings(r, `W${i}`, 'thor', foe, Array<Outcome>(4 - i).fill('A'))
    }

    const thor = (await board(r)).of('thor')!
    // A full pairwise table is the roster squared; the page shows the two extremes, and the cap
    // is applied where the sort happens rather than trusted to the screen.
    expect(thor.best.map((m) => m.characterId)).toEqual(['ninja', 'druid', 'santa'])
  })

  it('does not report a mirror as a matchup with itself', async () => {
    const r = registry()
    await seed(r, 'R1', {
      rounds: ['A', 'B'],
      A: { lineup: ['thor', 'thor'], drafted: ['thor'], played: ['thor'] },
      B: { lineup: ['thor', 'thor'], drafted: ['thor'], played: ['thor'] },
    })

    const thor = (await board(r)).of('thor')!
    // D1 allows Thor against Thor, and its record against itself is 1–1 by construction — an
    // entry that can only ever say "level" and would sit in the middle of the ranking saying
    // nothing. The rounds still count towards its own totals, where they mean something.
    expect(thor.best).toEqual([])
    expect(thor.worst).toEqual([])
    expect(thor).toMatchObject({ wins: 2, losses: 2 })
  })

  it('has nothing to say about a hero from before the record kept a lineup', async () => {
    const r = registry()
    await seed(r, 'OLD001', {
      rounds: ['A', 'B'],
      A: { drafted: ['thor'], played: ['thor'] },
      B: { drafted: ['ninja'], played: ['ninja'] },
    })

    const thor = (await board(r)).of('thor')!
    // Those rounds cannot be attributed to a hero at all, so they cannot be attributed to a
    // pairing either. Drafted still counts; the matchup lists are empty rather than guessed at.
    expect(thor).toMatchObject({ drafted: 1, best: [], worst: [] })
  })
})

/**
 * **What the record could always have told us.**
 *
 * D45 claimed a round from before it "cannot be attributed to a hero at all". That was too strong,
 * and these are the cases it was wrong about: `consumed` is set when a seat *selects*, so the
 * stored `played` list holds one hero per round that happened. The order is missing; the results
 * are not always missing with it.
 *
 * The line these draw is between what follows from the record and what would have to be invented.
 */
describe('deducing a hero’s round from a record that never named it', () => {
  it('settles every hero in a match that went one way', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A', null],
      // The pre-D45 shape: what each seat used, in slot order, with no lineup beside it.
      A: { drafted: ['thor', 'loki', 'santa'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid', 'santa'], played: ['ninja', 'druid'] },
    })

    const heroes = await board(r)
    /*
     * A 2–0. Whichever order Thor and Loki went in, each of them won its own round — the order is
     * unknowable and the result is not. Both of B's lost theirs for the same reason.
     */
    expect(heroes.of('thor')).toMatchObject({ wins: 1, losses: 0, draws: 0 })
    expect(heroes.of('loki')).toMatchObject({ wins: 1, losses: 0, draws: 0 })
    expect(heroes.of('ninja')).toMatchObject({ wins: 0, losses: 1 })
    expect(heroes.unattributedRounds).toBe(0)
  })

  it('will not say who faced whom in one, because the record does not know', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A'],
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'] },
    })

    // Thor beat one of Ninja and Druid and there are two readings of which. The totals above are
    // the same under both; a matchup is not, so there is none.
    expect((await board(r)).of('thor')!.best).toEqual([])
    expect((await board(r)).of('ninja')!.worst).toEqual([])
  })

  it('settles the pairing as well when only one round was played', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['B'],
      A: { drafted: ['thor', 'loki', 'santa'], played: ['thor'] },
      B: { drafted: ['ninja', 'druid', 'santa'], played: ['ninja'] },
    })

    const heroes = await board(r)
    // One round means one hero a side, so who faced whom is not a guess. This is every game the
    // `bo1-bring3-ban1` mode has ever produced.
    expect(heroes.of('ninja')!.best).toMatchObject([{ characterId: 'thor', wins: 1, losses: 0 }])
    expect(heroes.of('thor')!.worst).toMatchObject([{ characterId: 'ninja', wins: 0, losses: 1 }])
  })

  it('settles a match that was drawn all the way through', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['TIE', 'TIE'],
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'] },
    })

    // Every round went the same way; that way was a draw (D21 makes it a real terminal state).
    expect((await board(r)).of('thor')).toMatchObject({ wins: 0, losses: 0, draws: 1 })
  })

  it('refuses a split, rather than halving a win nobody won', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'B'],
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'] },
    })

    const heroes = await board(r)
    /*
     * One of Thor and Loki won and one lost, and nothing in the record says which. Splitting the
     * difference would put a result on a public table that no game produced, in the one place
     * nobody could check it.
     */
    expect(heroes.of('thor')).toMatchObject({ wins: 0, losses: 0, draws: 0, played: 1 })
    expect(heroes.unattributedRounds).toBe(2)
  })

  it('says nothing when the heroes and the rounds do not add up', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A'],
      // Three heroes used across two rounds is not a record this deduction understands. One
      // consumed slot per played round is the premise; a row that breaks it gets no inference.
      A: { drafted: ['thor', 'loki', 'santa'], played: ['thor', 'loki', 'santa'] },
      B: { drafted: ['ninja'], played: ['ninja', 'druid'] },
    })

    const heroes = await board(r)
    expect(heroes.of('thor')).toMatchObject({ wins: 0, losses: 0, draws: 0 })
    expect(heroes.unattributedRounds).toBe(2)
  })

  it('prefers what was written down to what can be worked out', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A'],
      // `played` is in slot order and the lineup says the play order was the other way round.
      // Only one of them is a record of what happened.
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'], lineup: ['loki', 'thor'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'], lineup: ['druid', 'ninja'] },
    })

    const heroes = await board(r)
    // Both heroes won either way — but the pairing only exists because the lineup was stored, and
    // it is the stored one rather than the order `played` happens to be in.
    expect(heroes.of('loki')!.best).toMatchObject([{ characterId: 'druid', wins: 1 }])
    expect(heroes.of('thor')!.best).toMatchObject([{ characterId: 'ninja', wins: 1 }])
  })
})

describe('the deduction against a real game', () => {
  it('reaches the same answer the engine recorded, with the lineup taken away', async () => {
    // A 2–0, played over sockets by two headless clients. `stopWhenDecided` ends it at two.
    const match = await seatedMatch({ modeId: 'base', draftCount: 4, players: ['dd-1', 'dd-2'] })
    await playToCompletion(match.a, match.b, ['A', 'A'])
    await match.a.settle(40)

    const stored = (await matchesSettle(1)).find((m) => m.roomCode === match.roomCode)!
    const detail = stored.detail as {
      rounds: (string | null)[]
      seats: Record<'A' | 'B', { drafted: string[]; played: string[]; lineup: (string | null)[] }>
    }
    expect(detail.seats.A.lineup.filter(Boolean)).toHaveLength(2)

    /*
     * The same game twice: once as D45 records it, and once as it would have been stored before
     * D45 — the heroes each seat used, and no order. If the deduction is sound the two boards
     * agree hero for hero, and this is the only test that can say so, because it is the only one
     * with the engine's own answer to check against.
     */
    const side = (seat: 'A' | 'B', withLineup: boolean) => ({
      drafted: detail.seats[seat].drafted,
      played: detail.seats[seat].played,
      ...(withLineup ? { lineup: detail.seats[seat].lineup } : {}),
    })
    const boardFor = async (withLineup: boolean) => {
      const stub = registry()
      await seed(stub, 'ROOM01', {
        rounds: detail.rounds as Outcome[],
        A: side('A', withLineup),
        B: side('B', withLineup),
      })
      const read = await board(stub)
      return {
        // Totals only. The recorded board also knows who faced whom; the deduced one cannot, and
        // says so by leaving the matchups empty rather than by getting them wrong.
        totals: read.heroes.map((h) => ({
          characterId: h.characterId,
          wins: h.wins,
          losses: h.losses,
          draws: h.draws,
        })),
        unattributed: read.unattributedRounds,
      }
    }

    const recorded = await boardFor(true)
    const deduced = await boardFor(false)
    expect(deduced.totals).toEqual(recorded.totals)
    expect(deduced.unattributed).toBe(0)
  })
})

/**
 * **D48 — the games behind a hero's row.**
 *
 * The board says a hero is 4–2–1; this says which games those were and who was holding it. Read
 * through the same `playedRoundsOf` the board counts, so the two cannot come to disagree — and the
 * properties worth pinning are the ones where a page like this is tempted to overstate: a deduced
 * round has no round number and no opponent, and saying otherwise would be the one invented thing
 * on the screen.
 */
describe('the games behind a hero', () => {
  const hero = async (stub: DurableObjectStub, characterId: string) =>
    (await (await stub.fetch(`https://r/hero?id=${characterId}`)).json()) as {
      characterId: string
      matchups: { characterId: string; wins: number; losses: number; draws: number }[]
      appearances: {
        roomCode: string
        format: string
        draftCount: number
        seat: 'A' | 'B'
        round: number | null
        outcome: 'WIN' | 'LOSS' | 'DRAW'
        player: { id: string; name: string }
        opponent: { id: string; name: string; hero: string | null }
      }[]
    }

  it('lists one entry per round, with who was holding it and what it met', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'B', 'A'],
      A: { lineup: ['thor', 'loki', 'thor'], drafted: ['thor', 'loki', 'santa', 'ninja'] },
      B: { lineup: ['ninja', 'druid', 'santa'], drafted: ['ninja', 'druid', 'santa', 'loki'] },
    })

    const thor = await hero(r, 'thor')
    // Two rounds in one match: a hero that plays twice appears twice, because the row above counts
    // rounds and this is that count opened up.
    expect(thor.appearances).toHaveLength(2)
    expect(thor.appearances[0]).toMatchObject({
      roomCode: 'ROOM01',
      seat: 'A',
      round: 0,
      outcome: 'WIN',
      player: { name: 'Tom' },
      opponent: { name: 'Alex', hero: 'ninja' },
    })
    expect(thor.appearances[1]).toMatchObject({
      round: 2,
      outcome: 'WIN',
      opponent: { hero: 'santa' },
    })
  })

  it('names the format and the draft from what the record holds', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      // Four slots is a Bo3 with overtime — every `ALWAYS_3_ROUNDS` mode allocates one.
      rounds: ['A', 'B', 'A', null],
      A: { lineup: ['thor', 'loki', 'thor', null], drafted: ['thor', 'loki', 'santa', 'ninja'] },
      B: { lineup: ['ninja', 'druid', 'santa', null], drafted: ['ninja', 'druid', 'santa'] },
    })
    await seed(r, 'ROOM02', {
      rounds: ['B'],
      A: { lineup: ['thor'], drafted: ['thor', 'loki', 'santa'] },
      B: { lineup: ['ninja'], drafted: ['ninja', 'druid', 'santa'] },
    })

    const thor = await hero(r, 'thor')
    const bo1 = thor.appearances.find((a) => a.roomCode === 'ROOM02')!
    const bo3 = thor.appearances.find((a) => a.roomCode === 'ROOM01')!
    // Derived from the round slots rather than stored, which is exact for every mode that has
    // shipped. `draftCount` is the seat's own drafted list, which has been stored since D29.
    expect(bo1).toMatchObject({ format: 'Bo1', draftCount: 3, outcome: 'LOSS' })
    expect(bo3).toMatchObject({ format: 'Bo3', draftCount: 4 })
  })

  it('says which round it cannot name, on a game the record only half remembers', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'A'],
      // A pre-D45 sweep: D47 knows both heroes won and cannot know in which order.
      A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja', 'druid'] },
    })

    const thor = await hero(r, 'thor')
    expect(thor.appearances).toHaveLength(1)
    // The result is a fact and the round number is not. A plausible "R1" here would be the only
    // invented thing on the page, in the place it would be least visible.
    expect(thor.appearances[0]).toMatchObject({ round: null, outcome: 'WIN' })
    expect(thor.appearances[0]!.opponent.hero).toBeNull()
    // And with no pairing there is no matchup to report either.
    expect(thor.matchups).toEqual([])
  })

  it('does name the round and the opponent when one round settles both', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['B'],
      A: { drafted: ['thor', 'loki'], played: ['thor'] },
      B: { drafted: ['ninja', 'druid'], played: ['ninja'] },
    })

    // One round played means one hero a side: the pairing is not a guess, so both are stated.
    const thor = await hero(r, 'thor')
    expect(thor.appearances[0]).toMatchObject({ round: 0, outcome: 'LOSS' })
    expect(thor.appearances[0]!.opponent.hero).toBe('ninja')
  })

  it('gives every opponent, not the three the board shows at each end', async () => {
    const r = registry()
    for (const [i, foe] of ['ninja', 'druid', 'santa', 'krampus', 'seraph'].entries()) {
      await seed(r, `R${i}`, {
        rounds: ['A'],
        A: { lineup: ['thor'] },
        B: { lineup: [foe] },
      })
    }

    const thor = await hero(r, 'thor')
    // The row is a summary and this is the page behind it; capping here would withhold exactly
    // what somebody opened it to read.
    expect(thor.matchups).toHaveLength(5)
    expect(thor.matchups.every((m) => m.wins === 1)).toBe(true)
  })

  it('keeps a level matchup, which the board’s two ends leave out', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A', 'B'],
      A: { lineup: ['thor', 'thor'] },
      B: { lineup: ['ninja', 'ninja'] },
    })

    const thor = await hero(r, 'thor')
    // 1–1 is neither a best nor a worst matchup, which is not a reason to hide it from the list of
    // everyone this hero has met — it is the pairing still worth arguing about.
    expect(thor.matchups).toMatchObject([{ characterId: 'ninja', wins: 1, losses: 1 }])
  })

  it('shows both sides of a mirror as two rounds and no matchup', async () => {
    const r = registry()
    await seed(r, 'ROOM01', {
      rounds: ['A'],
      A: { lineup: ['thor'] },
      B: { lineup: ['thor'] },
    })

    const thor = await hero(r, 'thor')
    // D1 allows Thor against Thor: it won that round and it lost it, and its record against itself
    // is level by construction — a matchup entry that could only ever say so.
    expect(thor.appearances.map((a) => a.outcome).sort()).toEqual(['LOSS', 'WIN'])
    expect(thor.matchups).toEqual([])
  })

  it('answers for a hero nobody has played, rather than failing', async () => {
    const r = registry()
    await seed(r, 'ROOM01', { rounds: ['A'], A: { lineup: ['thor'] }, B: { lineup: ['ninja'] } })

    const nobody = await hero(r, 'krampus')
    expect(nobody).toMatchObject({ characterId: 'krampus', matchups: [], appearances: [] })
  })

  it('refuses a request that names no hero', async () => {
    const r = registry()
    expect((await r.fetch('https://r/hero')).status).toBe(400)
  })
})

/**
 * **D51 — the record actually collects what the pages ask for.**
 *
 * Every other test here seeds the registry by hand, which proves the aggregation and proves
 * nothing about whether a played match produces the shape it aggregates. These play one and read
 * what was filed: the gap D51 closed was between the match and the record, so that is where it has
 * to be checked.
 */
describe('what a played match now writes down', () => {
  it('files the mode, the selection order, and the round bans', async () => {
    const match = await seatedMatch({ modeId: 'base', draftCount: 4, players: ['col-1', 'col-2'] })
    await playToCompletion(match.a, match.b, ['A', 'B', 'A'])
    await match.a.settle(40)

    const stored = (await matchesSettle(1)).find((m) => m.roomCode === match.roomCode)!
    const detail = stored.detail as {
      rounds: (string | null)[]
      modeId?: string
      firstToSelect?: (string | null)[]
      seats: Record<'A' | 'B', { roundBans?: (string | null)[]; lineup: (string | null)[] }>
    }

    // The mode, rather than a format inferred from how many slots the record happens to hold.
    expect(detail.modeId).toBe('base')

    /*
     * One entry per round slot, aligned with `rounds` exactly as `lineup` is. Rounds 0 and 1
     * select in public and have an order; round 2 is `SIMULTANEOUS_HIDDEN`, where both seats
     * commit blind and the order the events arrived in is an accident rather than a decision.
     */
    expect(detail.firstToSelect).toHaveLength(detail.rounds.length)
    expect(detail.firstToSelect!.slice(0, 2).every((s) => s === 'A' || s === 'B')).toBe(true)
    expect(detail.firstToSelect![2]).toBeNull()

    // The round ban, stored as the character it denied rather than the slot index it named — an
    // index means nothing to a reader with no board to resolve it against.
    expect(detail.seats.A.roundBans).toHaveLength(detail.rounds.length)
    const denied = detail.seats.A.roundBans!.filter((id): id is string => typeof id === 'string')
    expect(denied.length).toBeGreaterThan(0)
    // Whatever A denied was on B's board, which is what D3 means by targeting an opponent slot.
    const theirs = (stored.detail as { seats: Record<'B', { drafted: string[] }> }).seats.B.drafted
    for (const id of denied) expect(theirs).toContain(id)
  })

  it('reaches the stats board as counter-picks and denials', async () => {
    const match = await seatedMatch({ modeId: 'base', draftCount: 4, players: ['col-3', 'col-4'] })
    await playToCompletion(match.a, match.b, ['A', 'A'])
    await match.a.settle(40)
    await matchesSettle(1)

    const page = (await (await SELF.fetch('https://example.com/api/stats')).json()) as {
      denied: { characterId: string; count: number }[]
      counterPicked: { characterId: string; count: number }[]
      sequentialRounds: number
    }

    /*
     * The point of the whole change: a match played today answers the two questions the board had
     * to leave blank. Two rounds played, both sequential in this mode, so both are counter-picks.
     */
    expect(page.sequentialRounds).toBeGreaterThan(0)
    expect(page.counterPicked.length).toBeGreaterThan(0)
    expect(page.denied.length).toBeGreaterThan(0)
  })
})
