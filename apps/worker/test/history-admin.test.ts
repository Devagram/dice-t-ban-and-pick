import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch } from './client.js'

/**
 * **D34 — the history page and the admin dashboard.**
 *
 * History is public and read-only: the same rows the standings are already derived from, shown
 * whole instead of summarised. Editing is not, and most of what follows is about that door being
 * shut properly — including when nobody configured a key at all.
 */

async function played(players: [string, string], results: ('A' | 'B' | 'TIE')[]) {
  const match = await seatedMatch({ modeId: 'base', draftCount: 4, players })
  await playToCompletion(match.a, match.b, results)
  await match.a.settle(40)
  return match
}

async function matchesSettle(min: number, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const body = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
      matches: { roomCode: string; detail: unknown; winnerId: string | null }[]
    }
    if (body.matches.length >= min) return body.matches
    await scheduler.wait(1)
  }
  throw new Error(`fewer than ${min} matches ever reached the history`)
}

const admin = (path: string, body: unknown, key?: string) =>
  SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'x-admin-key': key }),
    },
    body: JSON.stringify(body),
  })

describe('the history page reads', () => {
  it('returns each match whole, with its rounds and both rosters', async () => {
    const { roomCode } = await played(['h-1', 'h-2'], ['A', 'B', 'A'])
    const matches = await matchesSettle(1)

    const mine = matches.find((m) => m.roomCode === roomCode)!
    expect(mine).toBeTruthy()
    const detail = mine.detail as {
      rounds: (string | null)[]
      seats: Record<'A' | 'B', { drafted: string[]; played: string[]; metaBan: unknown }>
    }
    // The Bo3 itself — what a standings table throws away.
    expect(detail.rounds.slice(0, 3)).toEqual(['A', 'B', 'A'])
    // And what each side brought, which is the other half of "show me the game".
    expect(detail.seats.A.drafted).toHaveLength(4)
    expect(detail.seats.B.drafted).toHaveLength(4)
    expect(detail.seats.A.played.length).toBeGreaterThan(0)
  })

  it('aggregates a pairing into one row read from either side', async () => {
    await played(['mu-1', 'mu-2'], ['A', 'B', 'A'])
    await played(['mu-1', 'mu-2'], ['B', 'B', 'A'])

    for (let i = 0; i < 80; i++) {
      const body = (await (await SELF.fetch('https://example.com/api/matchups')).json()) as {
        matchups: {
          a: { id: string }
          b: { id: string }
          aWins: number
          bWins: number
          played: number
        }[]
      }
      const pair = body.matchups.find(
        (m) => [m.a.id, m.b.id].includes('mu-1') && [m.a.id, m.b.id].includes('mu-2'),
      )
      if (pair && pair.played === 2) {
        // One row, both directions. 1-1 whichever way round the ids sorted.
        expect(pair.aWins + pair.bWins).toBe(2)
        expect(pair.aWins).toBe(1)
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the pairing never aggregated')
  })
})

describe('the admin door', () => {
  it('refuses without a key', async () => {
    const { roomCode } = await played(['ad-1', 'ad-2'], ['A', 'B', 'A'])
    await matchesSettle(1)
    expect((await admin('edit', { roomCode, scoreA: 99 })).status).toBe(401)
  })

  it('refuses a wrong key', async () => {
    const { roomCode } = await played(['ad-3', 'ad-4'], ['A', 'B', 'A'])
    await matchesSettle(1)
    expect((await admin('edit', { roomCode }, 'not-the-key')).status).toBe(401)
  })

  it('refuses a key of the right shape but the wrong value', async () => {
    // Same length as the configured key, so this is the comparison being tested rather than the
    // length check in front of it.
    const same = 'x'.repeat(String(env.ADMIN_KEY ?? 'test-admin-key').length)
    const { roomCode } = await played(['ad-5', 'ad-6'], ['A', 'B', 'A'])
    await matchesSettle(1)
    expect((await admin('edit', { roomCode }, same)).status).toBe(401)
  })

  it('accepts the configured key', async () => {
    const { roomCode } = await played(['ad-7', 'ad-8'], ['A', 'B', 'A'])
    await matchesSettle(1)
    const response = await admin('edit', { roomCode, aName: 'Corrected' }, String(env.ADMIN_KEY))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { match: { a: { name: string } } }).match.a.name).toBe(
      'Corrected',
    )
  })
})

describe('a deployment with no key configured', () => {
  it('has no admin at all, rather than an admin anyone can be', async () => {
    const configured = env.ADMIN_KEY
    // The state of a deployment that never ran `wrangler secret put`. Failing open here would
    // hand every visitor the power to rewrite every recorded result.
    delete (env as { ADMIN_KEY?: string }).ADMIN_KEY
    try {
      const response = await admin('edit', { roomCode: 'ANY123', scoreA: 5 }, 'anything')
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: string }).error).toBe('ADMIN_DISABLED')

      // And with no key offered either — still shut, not merely unauthenticated.
      expect((await admin('delete', { roomCode: 'ANY123' })).status).toBe(503)
    } finally {
      if (configured === undefined) delete (env as { ADMIN_KEY?: string }).ADMIN_KEY
      else (env as { ADMIN_KEY?: string }).ADMIN_KEY = configured
    }
  })
})

describe('what an admin edit changes', () => {
  const key = () => String(env.ADMIN_KEY)

  it('rewrites the winner and the standings follow', async () => {
    const { roomCode } = await played(['ed-1', 'ed-2'], ['A', 'A', 'A'])
    await matchesSettle(1)

    await admin('edit', { roomCode, winnerId: 'B', scoreA: 1, scoreB: 2 }, key())

    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=ed-1&b=ed-2')
    ).json()) as { wins: number; losses: number }
    // Totals are derived from the stored rows, so an edit moves them without a recount step.
    expect(h2h).toMatchObject({ wins: 0, losses: 1 })
  })

  it('sets a draw, which `??` would have made unreachable', async () => {
    const { roomCode } = await played(['ed-3', 'ed-4'], ['A', 'B', 'A'])
    await matchesSettle(1)

    await admin('edit', { roomCode, winnerId: null }, key())

    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=ed-3&b=ed-4')
    ).json()) as { draws: number }
    expect(h2h.draws).toBe(1)
  })

  it('leaves fields it was not given alone', async () => {
    const { roomCode } = await played(['ed-5', 'ed-6'], ['A', 'B', 'A'])
    const before = (await matchesSettle(1)).find((m) => m.roomCode === roomCode)!

    await admin('edit', { roomCode, aName: 'Renamed' }, key())

    const after = (await matchesSettle(1)).find((m) => m.roomCode === roomCode)!
    // Correcting a name must not quietly reset a score or wipe the rosters.
    expect(after.winnerId).toBe(before.winnerId)
    expect(after.detail).toEqual(before.detail)
  })

  it('rewrites round results without touching the rosters beside them', async () => {
    const { roomCode } = await played(['ed-7', 'ed-8'], ['A', 'B', 'A'])
    const before = (await matchesSettle(1)).find((m) => m.roomCode === roomCode)!
    const drafted = (before.detail as { seats: { A: { drafted: string[] } } }).seats.A.drafted

    await admin('edit', { roomCode, rounds: ['B', 'B', null, null] }, key())

    const after = (await matchesSettle(1)).find((m) => m.roomCode === roomCode)!
    const detail = after.detail as {
      rounds: (string | null)[]
      seats: { A: { drafted: string[] } }
    }
    expect(detail.rounds).toEqual(['B', 'B', null, null])
    expect(detail.seats.A.drafted).toEqual(drafted)
  })

  it('deletes a record, and it stops counting everywhere', async () => {
    const { roomCode } = await played(['ed-9', 'ed-10'], ['A', 'B', 'A'])
    await matchesSettle(1)

    expect((await admin('delete', { roomCode }, key())).status).toBe(200)

    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=ed-9&b=ed-10')
    ).json()) as { matches: unknown[] }
    expect(h2h.matches).toHaveLength(0)
  })

  it('404s on a match that does not exist rather than inventing one', async () => {
    expect((await admin('edit', { roomCode: 'ZZZZZZ', scoreA: 3 }, key())).status).toBe(404)
  })
})

/**
 * **D44 — adding a game that was played somewhere else.**
 *
 * Every other row in `matches` is the residue of a match this deployment refereed. These are not,
 * and the tests worth having are about that difference holding: the record counts everywhere a
 * played one does, it is marked as hand-written rather than passed off as reported, and it cannot
 * be used to reach the two places D34 and D39 keep shut — the door with no key, and a bracket.
 */
describe('adding a match by hand', () => {
  const key = () => String(env.ADMIN_KEY)

  const add = (body: Record<string, unknown>, useKey = key()) => admin('add', body, useKey)

  const added = async (body: Record<string, unknown>) => {
    const response = await add(body)
    expect(response.status).toBe(200)
    return ((await response.json()) as { match: MatchRecordish }).match
  }

  it('refuses without the key, like every other write to the record', async () => {
    // `admin` rather than `add`: the no-key case has to send no header at all, which a default
    // argument cannot express.
    expect((await admin('add', { aId: 'nk-1', bId: 'nk-2', winnerId: 'A' })).status).toBe(401)
    expect((await add({ aId: 'nk-1', bId: 'nk-2', winnerId: 'A' }, 'not-the-key')).status).toBe(401)
  })

  it('files a match nobody played here, and the standings count it', async () => {
    const match = await added({
      aId: 'add-1',
      aName: 'Tom',
      bId: 'add-2',
      bName: 'Alex',
      winnerId: 'A',
      scoreA: 2,
      scoreB: 1,
      rounds: ['A', 'B', 'A'],
    })

    // The winner comes back as a player id: the dashboard speaks seats, storage speaks ids, and a
    // seat letter left in `winner_id` would count for nobody.
    expect(match.winnerId).toBe('add-1')

    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=add-1&b=add-2')
    ).json()) as { wins: number; losses: number; matches: { roomCode: string }[] }
    expect(h2h).toMatchObject({ wins: 1, losses: 0 })
    expect(h2h.matches.map((m) => m.roomCode)).toContain(match.roomCode)
  })

  it('takes a code no room can ever have', async () => {
    const match = await added({ aId: 'code-1', bId: 'code-2', winnerId: 'B' })
    /*
     * `record` upserts by room code. A hand-added row wearing a plausible six-character code would
     * be silently overwritten the day `generateRoomCode` minted the same one for a real game — so
     * the prefix is what keeps the two namespaces apart, not a decoration.
     */
    expect(match.roomCode.startsWith('M-')).toBe(true)
    expect(match.roomCode).toHaveLength(8)
  })

  it('gives each added game its own row rather than upserting over the last', async () => {
    const first = await added({ aId: 'twice-1', bId: 'twice-2', winnerId: 'A' })
    const second = await added({ aId: 'twice-1', bId: 'twice-2', winnerId: 'B' })

    expect(second.roomCode).not.toBe(first.roomCode)
    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=twice-1&b=twice-2')
    ).json()) as { wins: number; losses: number }
    // Two evenings are two games. `record` collapses a repeat because a match that completes twice
    // is one match; this must not, or the second entry deletes the first.
    expect(h2h).toMatchObject({ wins: 1, losses: 1 })
  })

  it('mints a player id for somebody who has never opened the site', async () => {
    const match = await added({
      aId: 'known-1',
      aName: 'Tom',
      bName: 'Visiting Sam',
      winnerId: 'B',
    })

    // A name with no id is the case this exists for — a friend with no browser here. It becomes a
    // real id, so it counts, it can be reassigned, and D35's merge folds it into their own later.
    expect(match.b.id).toMatch(/^p_/)
    expect(match.b.name).toBe('Visiting Sam')
    expect(match.winnerId).toBe(match.b.id)

    const players = (await (
      await SELF.fetch('https://example.com/api/admin/players', {
        headers: { 'x-admin-key': key() },
      })
    ).json()) as { players: { playerId: string; played: number; wins: number }[] }
    expect(players.players.find((p) => p.playerId === match.b.id)).toMatchObject({
      played: 1,
      wins: 1,
    })
  })

  it('refuses a seat that names nobody at all', async () => {
    const response = await add({ aId: 'lonely-1', winnerId: 'A' })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('MISSING_PLAYER')
  })

  it('refuses a match somebody played against themselves', async () => {
    const response = await add({ aId: 'same-1', bId: 'same-1', winnerId: 'A' })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe('SELF_MATCH')
  })

  it('stores no rosters, because nobody drafted anything', async () => {
    const match = await added({ aId: 'plain-1', bId: 'plain-2', winnerId: null, rounds: ['TIE'] })
    // A record with an empty pair of rosters would make a game that was never drafted look like
    // one that was. `rounds` alone is what the history renders for it.
    expect(match.detail).toEqual({ rounds: ['TIE'] })
    expect((match.detail as { seats?: unknown }).seats).toBeUndefined()
  })

  it('drops trailing rounds nobody played rather than storing them as unplayed', async () => {
    const match = await added({
      aId: 'trail-1',
      bId: 'trail-2',
      winnerId: 'A',
      rounds: ['A', 'A', null, null],
    })
    // `stopWhenDecided` makes a stored `null` mean "the match ended before this round". A row that
    // was simply left blank must not claim that.
    expect(match.detail).toEqual({ rounds: ['A', 'A'] })

    const empty = await added({ aId: 'trail-3', bId: 'trail-4', winnerId: 'A', rounds: [null] })
    expect(empty.detail).toBeNull()
  })

  it('files the evening it was played, not the evening it was typed in', async () => {
    const march = new Date(2026, 2, 14, 20).getTime()
    const match = await added({ aId: 'when-1', bId: 'when-2', winnerId: 'A', playedAt: march })
    expect(match.playedAt).toBe(march)

    // Nonsense from a date field that failed to parse would file the game in 1970 and bury it
    // under everything, which is the one thing this column must not do.
    const fallback = await added({ aId: 'when-3', bId: 'when-4', winnerId: 'A', playedAt: 0 })
    expect(fallback.playedAt).toBeGreaterThan(march)
  })

  it('never claims to belong to a tournament, however hard it is asked', async () => {
    const match = await added({
      aId: 'bracket-1',
      bId: 'bracket-2',
      winnerId: 'A',
      tournamentId: 'T-ABC123',
    })
    /*
     * D39: a bracket derives itself from resolved slots, so a hand-written row claiming to be a
     * tournament match is the second truth that decision exists to prevent. It is also the one
     * that would make `edit` refuse to touch its own row afterwards.
     */
    expect(match.tournamentId).toBeUndefined()

    const editable = await admin('edit', { roomCode: match.roomCode, scoreA: 7 }, key())
    expect(editable.status).toBe(200)
  })

  it('has no admin at all on a deployment with no key', async () => {
    const configured = env.ADMIN_KEY
    delete (env as { ADMIN_KEY?: string }).ADMIN_KEY
    try {
      const response = await add({ aId: 'shut-1', bId: 'shut-2', winnerId: 'A' }, 'anything')
      expect(response.status).toBe(503)
      expect(((await response.json()) as { error: string }).error).toBe('ADMIN_DISABLED')
    } finally {
      if (configured === undefined) delete (env as { ADMIN_KEY?: string }).ADMIN_KEY
      else (env as { ADMIN_KEY?: string }).ADMIN_KEY = configured
    }
  })
})

/** Just enough of the stored shape for these assertions; the client owns the real type. */
interface MatchRecordish {
  roomCode: string
  playedAt: number
  a: { id: string; name: string }
  b: { id: string; name: string }
  winnerId: string | null
  detail: unknown
  tournamentId?: string
}

/**
 * **D46 — naming the heroes on a record the admin is writing by hand.**
 *
 * D44 stored no heroes at all for an added match, which was defensible while nothing counted them
 * and became a hole the moment D45's board did: a game played away from the site could reach the
 * leaderboard and never the hero board. These are about that data arriving intact, and about the
 * one thing a free-text id would cost — a hero nobody has heard of on a public table.
 *
 * Asserted as deltas rather than totals. Other tests in this file play real matches, those drafts
 * are drawn from the same roster, and a suite that only passes while nobody else happens to draft
 * Thor is a suite that will fail for a reason nobody can find.
 */
describe('naming the heroes on a hand-added match', () => {
  const key = () => String(env.ADMIN_KEY)

  const added = async (body: Record<string, unknown>) => {
    const response = await admin('add', body, key())
    expect(response.status).toBe(200)
    return ((await response.json()) as { match: AddedMatch }).match
  }

  const heroCount = async (characterId: string) => {
    const body = (await (await SELF.fetch('https://example.com/api/heroes')).json()) as {
      heroes: HeroRow[]
    }
    return (
      body.heroes.find((h) => h.characterId === characterId) ?? {
        characterId,
        drafted: 0,
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      }
    )
  }

  it('credits the hero board with a game that was never played here', async () => {
    const before = await heroCount('thor')

    await added({
      aId: 'hero-add-1',
      bId: 'hero-add-2',
      winnerId: 'A',
      scoreA: 2,
      scoreB: 1,
      rounds: ['A', 'B', 'A'],
      aLineup: ['thor', 'loki', 'thor'],
      bLineup: ['ninja', 'druid', 'santa'],
    })

    // The point of the whole feature: an evening played away from the site now reaches `/heroes`
    // as real rounds rather than as a result no hero can be credited with.
    const after = await heroCount('thor')
    expect(after.wins - before.wins).toBe(2)
    expect(after.draws - before.draws).toBe(0)
    expect(after.played - before.played).toBe(1)
  })

  it('gives the other seat its side of the same rounds', async () => {
    const before = await heroCount('druid')
    await added({
      aId: 'hero-add-3',
      bId: 'hero-add-4',
      winnerId: 'B',
      rounds: ['A', 'B'],
      aLineup: ['thor', 'loki'],
      bLineup: ['ninja', 'druid'],
    })

    // Druid played round two and B won it. One set of rounds, two sides that cannot disagree.
    const after = await heroCount('druid')
    expect(after.wins - before.wins).toBe(1)
    expect(after.losses - before.losses).toBe(0)
  })

  it('records what was on the table as what was brought, and nothing more', async () => {
    const match = await added({
      aId: 'hero-add-5',
      bId: 'hero-add-6',
      winnerId: 'A',
      rounds: ['A', 'A'],
      aLineup: ['krampus', 'krampus'],
      bLineup: ['seraph', 'treant'],
    })

    // There was no draft, so "what this seat brought" can only honestly mean "what it played".
    // Inventing a bench would put a number on the hero board that no game produced.
    const seats = (match.detail as StoredSeats).seats
    expect(seats.A.drafted).toEqual(['krampus'])
    expect(seats.A.played).toEqual(['krampus'])
    expect(seats.A.lineup).toEqual(['krampus', 'krampus'])
    expect(seats.B.drafted).toEqual(['seraph', 'treant'])
  })

  it('refuses a hero the roster has never heard of', async () => {
    const response = await admin(
      'add',
      { aId: 'hero-add-7', bId: 'hero-add-8', winnerId: 'A', rounds: ['A'], aLineup: ['batman'] },
      key(),
    )
    // A typo'd id is a phantom hero on a public table, and unlike a wrong score nobody would
    // recognise it as an error. The dashboard picks from a menu; the server does not rely on that.
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('UNKNOWN_HERO')
  })

  it('still records a match with no heroes named at all', async () => {
    const match = await added({
      aId: 'hero-add-9',
      bId: 'hero-add-10',
      winnerId: 'A',
      rounds: ['A'],
    })
    // D44's original shape, unchanged: a result, and no claim about who played it. The hero board
    // counts that round as one it cannot credit rather than guessing at one.
    expect((match.detail as StoredSeats).seats).toBeUndefined()
  })
})

describe('correcting the heroes on a stored match', () => {
  const key = () => String(env.ADMIN_KEY)

  const addFor = async (body: Record<string, unknown>) =>
    ((await (await admin('add', body, key())).json()) as { match: AddedMatch }).match

  it('attributes the rounds of a record that had none on it', async () => {
    const { roomCode } = await addFor({
      aId: 'hero-fix-1',
      bId: 'hero-fix-2',
      winnerId: 'A',
      rounds: ['A', 'B'],
    })

    const edited = await admin(
      'edit',
      { roomCode, aLineup: ['pyromancer', 'pyromancer'], bLineup: ['iceman', 'iceman'] },
      key(),
    )
    expect(edited.status).toBe(200)

    /*
     * This is the only path there is for an old record: the match's own Durable Object expired
     * long ago, so the dashboard is where a round becomes attributable or stays uncredited for
     * good. D44's read-only rosters were the right call before anything counted them.
     */
    const seats = (((await edited.json()) as { match: AddedMatch }).match.detail as StoredSeats)
      .seats
    expect(seats.A.lineup).toEqual(['pyromancer', 'pyromancer'])
    expect(seats.B.played).toEqual(['iceman'])
  })

  it('keeps a drafted hero the edit was never told about', async () => {
    const { roomCode } = await addFor({
      aId: 'hero-fix-3',
      bId: 'hero-fix-4',
      winnerId: 'A',
      rounds: ['A'],
      aLineup: ['monk'],
      bLineup: ['ninja'],
    })

    const edited = await admin('edit', { roomCode, aLineup: ['samurai'] }, key())
    const seats = (((await edited.json()) as { match: AddedMatch }).match.detail as StoredSeats)
      .seats

    /*
     * `played` follows the lineup, because the lineup *is* what was played — leaving the old value
     * would put the wrong hero on the board beside the right one. `drafted` only grows: a hero
     * drafted and benched is a real thing the record knows and this edit was never told about.
     */
    expect(seats.A.played).toEqual(['samurai'])
    expect(seats.A.drafted).toEqual(['monk', 'samurai'])
  })

  it('leaves the heroes alone when an edit does not mention them', async () => {
    const { roomCode } = await addFor({
      aId: 'hero-fix-5',
      bId: 'hero-fix-6',
      winnerId: 'A',
      rounds: ['A'],
      aLineup: ['rogue'],
      bLineup: ['ninja'],
    })

    // Partial by design, like every other field here: correcting a name must not wipe a lineup.
    const edited = await admin('edit', { roomCode, aName: 'Renamed' }, key())
    const seats = (((await edited.json()) as { match: AddedMatch }).match.detail as StoredSeats)
      .seats
    expect(seats.A.lineup).toEqual(['rogue'])
  })

  it('does not let a save with no heroes on it erase what the match reported', async () => {
    /*
     * The bug this exists for: the dashboard sends both lineups whole on every save, so opening a
     * real match recorded before D45 — a genuine `played` list, no lineup — and fixing its *score*
     * arrives here with four nulls. Following that would delete what the match itself said about
     * which characters were used, in a request that was about a number.
     */
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
    await registry.fetch('https://registry/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomCode: 'PRE045',
        playedAt: 1,
        a: { id: 'pre-1', name: 'Tom' },
        b: { id: 'pre-2', name: 'Alex' },
        winnerId: 'pre-1',
        scoreA: 2,
        scoreB: 1,
        detail: {
          rounds: ['A', 'B', 'A'],
          seats: {
            A: { drafted: ['thor', 'loki'], played: ['thor', 'loki'], metaBan: null },
            B: { drafted: ['ninja'], played: ['ninja'], metaBan: null },
          },
        },
      }),
    })

    const edited = await admin(
      'edit',
      { roomCode: 'PRE045', scoreA: 3, aLineup: [null, null, null], bLineup: [null, null, null] },
      key(),
    )
    const seats = (((await edited.json()) as { match: AddedMatch }).match.detail as StoredSeats)
      .seats

    // The score lands; the heroes the match reported stay exactly where they were.
    expect(seats.A.played).toEqual(['thor', 'loki'])
    expect(seats.A.drafted).toEqual(['thor', 'loki'])
  })

  it('refuses an unknown hero without applying the rest of the same edit', async () => {
    const { roomCode } = await addFor({
      aId: 'hero-fix-7',
      bId: 'hero-fix-8',
      winnerId: 'A',
      scoreA: 1,
      rounds: ['A'],
      aLineup: ['rogue'],
    })

    const refused = await admin('edit', { roomCode, scoreA: 9, aLineup: ['spider-ham'] }, key())
    expect(refused.status).toBe(400)

    // A refused edit is refused whole. Half-applying one — the score in, the lineup out — would
    // leave the record saying something nobody asked for and nobody was told about.
    const after = (await matchesSettle(1)).find((m) => m.roomCode === roomCode) as
      { scoreA: number } | undefined
    expect(after?.scoreA).toBe(1)
  })
})

/** The stored shape these assertions reach into. The client owns the real types. */
interface AddedMatch {
  roomCode: string
  detail: unknown
}

interface HeroRow {
  characterId: string
  drafted: number
  played: number
  wins: number
  losses: number
  draws: number
}

interface StoredSeats {
  seats: Record<'A' | 'B', { drafted: string[]; played: string[]; lineup: (string | null)[] }>
}
