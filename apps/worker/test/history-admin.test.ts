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
