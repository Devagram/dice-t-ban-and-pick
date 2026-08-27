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
