import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch } from './client.js'

/**
 * **D35 — the player directory, and merging two ids that are one person.**
 *
 * The thing being tested is not really "an endpoint". It is that a player id is per-browser by
 * design (D19 chose no accounts) and therefore duplicates are *expected* rather than exceptional:
 * a second laptop is a second player until somebody says otherwise. These cover the saying-so,
 * and the two places it could quietly corrupt a total — a winner id left pointing at a merged-away
 * player, and a merge that makes someone their own opponent.
 *
 * Several assertions are grouped into one test rather than split one-per-`it`, which is not the
 * style of the rest of the suite and is deliberate: every match here is played over real sockets
 * in workerd, and this file's arrival was enough on its own to push `session.test.ts` — which
 * runs concurrently against a 5-second limit — over the edge. Six matches instead of nine is the
 * difference between a green suite and a flake in a file nobody changed.
 */

const key = () => String(env.ADMIN_KEY)

async function played(players: [string, string], results: ('A' | 'B' | 'TIE')[]) {
  const match = await seatedMatch({ modeId: 'base', draftCount: 4, players })
  await playToCompletion(match.a, match.b, results)
  await match.a.settle(40)
  return match
}

const admin = (path: string, body: unknown, adminKey: string = key()) =>
  SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify(body),
  })

const directory = (adminKey: string = key()) =>
  SELF.fetch('https://example.com/api/admin/players', { headers: { 'x-admin-key': adminKey } })

interface Summary {
  playerId: string
  name: string
  claimedNames: string[]
  played: number
  wins: number
  losses: number
  draws: number
}

/** The registry writes on a `waitUntil`, so every read here is "wait for it to show up". */
async function settled(predicate: (players: Summary[]) => boolean, tries = 80): Promise<Summary[]> {
  for (let i = 0; i < tries; i++) {
    const body = (await (await directory()).json()) as { players: Summary[] }
    if (predicate(body.players)) return body.players
    await scheduler.wait(1)
  }
  throw new Error('the directory never reached the expected state')
}

const find = (players: Summary[], id: string) => players.find((p) => p.playerId === id)

describe('the player directory', () => {
  it('is behind the admin key, on the same door as the edits it feeds', async () => {
    /*
     * Not because it makes ids secret — `/api/matches` is public and names both ids on every
     * row. It is gated because it lists ids that have *never* played, which nothing public
     * carries, and because it is the inventory `merge` operates on.
     */
    expect((await directory('not-the-key')).status).toBe(401)
    expect((await SELF.fetch('https://example.com/api/admin/players')).status).toBe(401)
  })

  it('lists every id with the record attached to it', async () => {
    await played(['dir-1', 'dir-2'], ['A', 'A'])
    const players = await settled((p) => find(p, 'dir-1') !== undefined)

    expect(find(players, 'dir-1')).toMatchObject({ played: 1, wins: 1, losses: 0, draws: 0 })
    expect(find(players, 'dir-2')).toMatchObject({ played: 1, wins: 0, losses: 1, draws: 0 })
  })

  it('includes an id that claimed a name but has never finished a match', async () => {
    // The exact shape of a returning player's new browser, and the one an admin came to merge.
    // Deriving the list from `matches` alone would hide precisely the row that matters.
    await SELF.fetch('https://example.com/api/player/name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'ghost-1', displayName: 'Ghost' }),
    })

    const players = await settled((p) => find(p, 'ghost-1') !== undefined)
    expect(find(players, 'ghost-1')).toMatchObject({
      played: 0,
      name: 'Ghost',
      claimedNames: ['Ghost'],
    })
  })
})

describe('merging two ids', () => {
  it('moves the matches, and the wins land on the surviving id everywhere', async () => {
    await played(['old-laptop', 'rival-1'], ['A', 'A'])
    await played(['new-laptop', 'rival-1'], ['B', 'B'])
    await settled((p) => find(p, 'old-laptop') !== undefined && find(p, 'new-laptop') !== undefined)

    const response = await admin('merge', { fromId: 'old-laptop', intoId: 'new-laptop' })
    expect(response.status).toBe(200)
    expect((await response.json()) as { moved: number }).toMatchObject({ moved: 1 })

    const players = await settled((p) => find(p, 'old-laptop') === undefined)
    // One row, both games. The win came from the merged-away id, so this is the `winner_id`
    // rewrite being tested rather than the match rows moving.
    expect(find(players, 'new-laptop')).toMatchObject({ played: 2, wins: 1, losses: 1 })

    // And every derived total follows, because they are all queries over the rows just rewritten
    // rather than counters that would need a recount step.
    const h2h = (await (
      await SELF.fetch('https://example.com/api/head-to-head?a=new-laptop&b=rival-1')
    ).json()) as { wins: number; losses: number; matches: unknown[] }
    expect(h2h).toMatchObject({ wins: 1, losses: 1 })
    expect(h2h.matches).toHaveLength(2)
  })

  it('refuses when the two ids ever played each other, naming the matches', async () => {
    const { roomCode } = await played(['twin-a', 'twin-b'], ['A', 'A'])
    await settled((p) => find(p, 'twin-a') !== undefined)

    const response = await admin('merge', { fromId: 'twin-a', intoId: 'twin-b' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; roomCodes: string[]; detail: string }
    // Naming them is the point: "refused" with no way to find the offending rows is a dead end,
    // and the fix (delete or reassign those matches) needs the codes.
    expect(body.error).toBe('SELF_MATCH')
    expect(body.roomCodes).toContain(roomCode)
    expect(body.detail).toContain(roomCode)

    // And nothing moved — a refusal must not be a half-done merge.
    const players = await settled((p) => find(p, 'twin-a') !== undefined)
    expect(find(players, 'twin-a')?.played).toBe(1)
  })

  it('refuses to merge an id into itself', async () => {
    expect((await admin('merge', { fromId: 'same', intoId: 'same' })).status).toBe(400)
    expect((await admin('merge', { fromId: 'lonely' })).status).toBe(400)
  })

  it('moves the name claim rather than releasing it', async () => {
    for (const [playerId, displayName] of [
      ['name-old', 'Renamer'],
      ['name-new', 'Renamer Two'],
    ]) {
      await SELF.fetch('https://example.com/api/player/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, displayName }),
      })
    }
    await settled((p) => find(p, 'name-old') !== undefined)

    await admin('merge', { fromId: 'name-old', intoId: 'name-new' })

    const players = await settled((p) => find(p, 'name-old') === undefined)
    // Both names now belong to the surviving id. Releasing "Renamer" would leave a name still
    // printed on the merged player's older matches free for a stranger to claim.
    expect(find(players, 'name-new')?.claimedNames.sort()).toEqual(['Renamer', 'Renamer Two'])
  })

  it('renames every merged row when given a name, so the history reads as one person', async () => {
    await played(['cap-old', 'cap-rival'], ['A', 'A'])
    await settled((p) => find(p, 'cap-old') !== undefined)

    await admin('merge', { fromId: 'cap-old', intoId: 'cap-new', name: 'Tom' })

    const matches = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
      matches: { a: { id: string; name: string }; b: { id: string; name: string } }[]
    }
    const moved = matches.matches.filter((m) => [m.a.id, m.b.id].includes('cap-new'))
    expect(moved.length).toBeGreaterThan(0)
    for (const m of moved) {
      // Without this the leaderboard shows one player whose older games are still captioned with
      // whatever the other browser called itself.
      expect(m.a.id === 'cap-new' ? m.a.name : m.b.name).toBe('Tom')
    }
    // The opponent is untouched: the rename follows the merged id, not the whole row.
    expect(moved.every((m) => (m.a.id === 'cap-new' ? m.b.name : m.a.name) !== 'Tom')).toBe(true)
  })
})

describe('reassigning a single match', () => {
  it('moves one game to another player and takes the win with it', async () => {
    const { roomCode } = await played(['borrow-1', 'borrow-2'], ['A', 'A'])
    await settled((p) => find(p, 'borrow-1') !== undefined)

    const response = await admin('edit', { roomCode, aId: 'borrow-3' })
    expect(response.status).toBe(200)
    const { match } = (await response.json()) as {
      match: { a: { id: string }; winnerId: string | null }
    }
    expect(match.a.id).toBe('borrow-3')
    // The winner is stored as an id. Leaving it on `borrow-1` would score the win for a player
    // who is no longer in the match — which reads downstream as a loss for the one who won.
    expect(match.winnerId).toBe('borrow-3')

    const players = await settled((p) => find(p, 'borrow-3') !== undefined)
    expect(find(players, 'borrow-3')).toMatchObject({ played: 1, wins: 1 })

    // And the seat cannot be moved onto its own opponent: `standings` scores a self-match as a
    // win *and* a loss for one person, so it is refused rather than stored.
    const refused = await admin('edit', { roomCode, aId: 'borrow-2' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toBe('SELF_MATCH')
  })

  it('leaves the ids alone when the edit does not mention them', async () => {
    const { roomCode } = await played(['keep-1', 'keep-2'], ['A', 'B', 'A'])
    await settled((p) => find(p, 'keep-1') !== undefined)

    await admin('edit', { roomCode, aName: 'Renamed' })

    const players = await settled((p) => find(p, 'keep-1') !== undefined)
    // D34's rule holds for the new fields too: what you did not send is not touched.
    expect(find(players, 'keep-1')).toMatchObject({ played: 1, wins: 1 })
    expect(find(players, 'keep-1')?.name).toBe('Renamed')
  })
})
