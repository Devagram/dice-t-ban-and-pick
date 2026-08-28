import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * **D49 — deleting a tournament, and correcting a name on one.**
 *
 * A tournament exists in three places — its own Durable Object, the registry's index, and the
 * `tournament_id` on every match it produced — and the tests that matter are the ones about all
 * three moving together. A delete that leaves the object alive is a tournament that refiles itself
 * and reappears; one that leaves the ids behind is a history full of links to a bracket that is
 * gone.
 */

const admin = (path: string, body: unknown, key?: string) =>
  SELF.fetch(`https://example.com/api/admin/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'x-admin-key': key }),
    },
    body: JSON.stringify(body),
  })

const key = () => String(env.ADMIN_KEY)

/** Files a tournament with the registry the way `TournamentDO` does on every write. */
const file = (
  code: string,
  over: { entrants?: string[]; champion?: string | null; complete?: boolean; view?: unknown } = {},
) =>
  env.REGISTRY.get(env.REGISTRY.idFromName('registry')).fetch('https://registry/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      format: 'SINGLE_ELIMINATION',
      entrants: over.entrants ?? ['Tom', 'Alex'],
      champion: over.champion === undefined ? 'Tom' : over.champion,
      createdAt: 1,
      complete: over.complete ?? true,
      view:
        over.view === undefined
          ? {
              code,
              entrants: [
                { entrantId: 'e1', displayName: 'Tom', seed: 1 },
                { entrantId: 'e2', displayName: 'Alex', seed: 2 },
              ],
              champion: 'e1',
            }
          : over.view,
    }),
  })

const record = (roomCode: string, tournamentId: string | null) =>
  env.REGISTRY.get(env.REGISTRY.idFromName('registry')).fetch('https://registry/record', {
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
      detail: null,
      ...(tournamentId ? { tournamentId } : {}),
    }),
  })

const listed = async () =>
  (
    (await (await SELF.fetch('https://example.com/api/tournaments')).json()) as {
      tournaments: { code: string; entrants: string[]; champion: string | null }[]
    }
  ).tournaments

describe('the tournament admin door', () => {
  it('refuses without the key, like every other write to the record', async () => {
    await file('T-AAA222')
    expect((await admin('deleteTournament', { code: 'T-AAA222' })).status).toBe(401)
    expect((await admin('renameEntrant', { code: 'T-AAA222', from: 'Tom', to: 'X' })).status).toBe(
      401,
    )
  })
})

describe('deleting a tournament', () => {
  it('takes it off the index', async () => {
    await file('T-BBB333')
    expect((await listed()).map((t) => t.code)).toContain('T-BBB333')

    expect((await admin('deleteTournament', { code: 'T-BBB333' }, key())).status).toBe(200)
    expect((await listed()).map((t) => t.code)).not.toContain('T-BBB333')
  })

  it('takes the archived bracket with it, so the page stops serving one', async () => {
    await file('T-CCC444')
    // A finished tournament's page falls through to this copy once its object is swept (D43). If
    // the delete left it behind, the bracket would outlive the tournament it belonged to.
    expect((await SELF.fetch('https://example.com/api/tournament/T-CCC444')).status).toBe(200)

    await admin('deleteTournament', { code: 'T-CCC444' }, key())
    expect((await SELF.fetch('https://example.com/api/tournament/T-CCC444')).status).toBe(404)
  })

  it('releases its matches rather than deleting them', async () => {
    await file('T-DDD555')
    await record('TRN31', 'T-DDD555')
    await record('TRN32', 'T-DDD555')
    await record('CAS31', null)

    const response = await admin('deleteTournament', { code: 'T-DDD555' }, key())
    expect(((await response.json()) as { released: number }).released).toBe(2)

    // The games were played and still count; they simply stop belonging to a bracket that is gone.
    const matches = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
      matches: { roomCode: string; tournamentId?: string }[]
    }
    expect(matches.matches.map((m) => m.roomCode).sort()).toEqual(['CAS31', 'TRN31', 'TRN32'])
    expect(matches.matches.every((m) => m.tournamentId === undefined)).toBe(true)
  })

  it('lets D39 release its grip on those matches with it', async () => {
    await file('T-EEE666')
    await record('TRN41', 'T-EEE666')
    // D39 refuses an admin edit of a bracket match, because the bracket would disagree.
    expect((await admin('edit', { roomCode: 'TRN41', scoreA: 9 }, key())).status).toBe(409)

    await admin('deleteTournament', { code: 'T-EEE666' }, key())
    // With no bracket left there is nothing for the record to contradict, so the refusal lifts.
    expect((await admin('edit', { roomCode: 'TRN41', scoreA: 9 }, key())).status).toBe(200)
  })

  it('closes the tournament object, so a live one cannot refile itself', async () => {
    const created = await SELF.fetch('https://example.com/api/tournament', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entrants: [
          { playerId: 'p-a', displayName: 'Tom' },
          { playerId: 'p-b', displayName: 'Alex' },
        ],
        config: { format: 'SINGLE_ELIMINATION', default: { modeId: 'base' } },
      }),
    })
    const { code } = (await created.json()) as { code: string }
    expect((await SELF.fetch(`https://example.com/api/tournament/${code}`)).status).toBe(200)

    await admin('deleteTournament', { code }, key())

    /*
     * The object is the half that would undo the other: every write inside it files a fresh
     * summary with the registry, so a tournament deleted from the index alone comes back the
     * moment somebody reports a result.
     */
    expect((await SELF.fetch(`https://example.com/api/tournament/${code}`)).status).toBe(404)
    expect((await listed()).map((t) => t.code)).not.toContain(code)
  })

  it('says nothing was deleted rather than half-doing it', async () => {
    expect((await admin('deleteTournament', {}, key())).status).toBe(400)
  })
})

describe('renaming an entrant', () => {
  it('corrects the index and the archived bracket together', async () => {
    await file('T-FFF777', { entrants: ['Tomn', 'Alex'], champion: 'Tomn' })

    const response = await admin(
      'renameEntrant',
      { code: 'T-FFF777', from: 'Tomn', to: 'Tom' },
      key(),
    )
    expect(response.status).toBe(200)

    const row = (await listed()).find((t) => t.code === 'T-FFF777')!
    // The champion here is stored as a name, so it is renamed with everybody else.
    expect(row.entrants).toEqual(['Tom', 'Alex'])
    expect(row.champion).toBe('Tom')

    // And the bracket the tournament page serves, which is read from a different column by a
    // different screen — renaming one of the two is how they come to disagree.
    const view = (await (
      await SELF.fetch('https://example.com/api/tournament/T-FFF777')
    ).json()) as { entrants: { displayName: string }[] }
    expect(view.entrants.map((e) => e.displayName)).toEqual(['Tom', 'Alex'])
  })

  it('refuses on a tournament that is still running, and says where to go', async () => {
    await file('T-GGG888', { complete: false, champion: null })

    const response = await admin(
      'renameEntrant',
      { code: 'T-GGG888', from: 'Tom', to: 'Thomas' },
      key(),
    )
    /*
     * Not caution: an unfinished tournament is still writing this record, so the rename would
     * survive until the next reported result and then vanish. The console renames at the source.
     */
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; detail: string }
    expect(body.error).toBe('TOURNAMENT_RUNNING')
    expect(body.detail).toContain('organizer console')
  })

  it('will not invent an entrant that was never in it', async () => {
    await file('T-HHH999')
    const response = await admin(
      'renameEntrant',
      { code: 'T-HHH999', from: 'Nobody', to: 'Somebody' },
      key(),
    )
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('NO_SUCH_ENTRANT')
  })

  it('404s on a tournament nobody has heard of', async () => {
    expect(
      (await admin('renameEntrant', { code: 'T-ZZZ999', from: 'Tom', to: 'X' }, key())).status,
    ).toBe(404)
  })

  it('still corrects the summary when the stored bracket cannot be read', async () => {
    // A view that will not parse is one this cannot rewrite; the caption is still worth fixing,
    // and the stored string keeps whatever it holds rather than being blanked.
    await file('T-JJJ222', { entrants: ['Tomn', 'Alex'], champion: 'Tomn', view: null })

    expect(
      (await admin('renameEntrant', { code: 'T-JJJ222', from: 'Tomn', to: 'Tom' }, key())).status,
    ).toBe(200)
    expect((await listed()).find((t) => t.code === 'T-JJJ222')!.champion).toBe('Tom')
  })
})
