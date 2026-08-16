import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * **D37 Phase 8 — the record that outlives the tournament.**
 *
 * The tension this phase is really about: `TournamentDO` is swept seven days after its last
 * activity (D42), which is right for a bracket nobody has touched in a week — and a week later is
 * usually exactly when somebody wants to look up who won. So the durable record lives in the
 * registry, beside the matches, and the object that produced it is allowed to disappear.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

interface Created {
  code: string
  organizerToken: string
  entrants: { entrantId: string; entrantToken: string }[]
}

async function createTournament(over: object = {}): Promise<Created> {
  const response = await SELF.fetch('https://example.com/api/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION' },
      ...over,
    }),
  })
  if (response.status !== 201) throw new Error(await response.text())
  return (await response.json()) as Created
}

const resolve = (created: Created, slotId: string, winner: string) =>
  SELF.fetch(`https://example.com/api/tournament/${created.code}/resolve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-organizer-key': created.organizerToken,
    },
    body: JSON.stringify({ slotId, winnerEntrantId: winner, reason: 'no-show' }),
  })

interface Summary {
  code: string
  format: string
  entrants: string[]
  champion: string | null
  complete: boolean
}

async function index(): Promise<Summary[]> {
  const body = (await (await SELF.fetch('https://example.com/api/tournaments')).json()) as {
    tournaments: Summary[]
  }
  return body.tournaments
}

/** Deletes a tournament's storage exactly as D42's alarm does, seven days on. */
async function sweep(code: string): Promise<void> {
  const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(code))
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll()
  })
}

/** The registry is written on a `waitUntil`, so every read here waits for it to land. */
async function settled(predicate: (list: Summary[]) => boolean, tries = 60): Promise<Summary[]> {
  for (let i = 0; i < tries; i++) {
    const list = await index()
    if (predicate(list)) return list
    await scheduler.wait(1)
  }
  throw new Error('the tournament index never reached the expected state')
}

describe('the tournament index', () => {
  it('lists a tournament from the moment it exists', async () => {
    const created = await createTournament()
    const list = await settled((l) => l.some((t) => t.code === created.code))

    const mine = list.find((t) => t.code === created.code)!
    expect(mine).toMatchObject({ format: 'SINGLE_ELIMINATION', champion: null, complete: false })
    // Names rather than ids, so the list reads without a second lookup.
    expect(mine.entrants).toEqual(['Player 1', 'Player 2', 'Player 3', 'Player 4'])
  })

  it('records the champion once there is one', async () => {
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')

    const list = await settled((l) => l.find((t) => t.code === created.code)?.complete === true)
    expect(list.find((t) => t.code === created.code)!.champion).toBe('Player 1')
  })

  it('is public, like the history it sits beside', async () => {
    await createTournament()
    // No key of any kind. A bracket is public and so is the list of them.
    expect((await SELF.fetch('https://example.com/api/tournaments')).status).toBe(200)
  })

  it('survives the tournament object being swept', async () => {
    /*
     * The whole point of Phase 8. D42 deletes a tournament's storage seven days after its last
     * activity; the record of who won has to be somewhere else by then, or "permanent page" is a
     * page that 404s exactly when it starts mattering.
     */
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')
    await settled((l) => l.find((t) => t.code === created.code)?.complete === true)

    await sweep(created.code)

    // And the record is still there.
    const after = (await index()).find((t) => t.code === created.code)
    expect(after).toMatchObject({ champion: 'Player 1', complete: true })
  })

  it('serves the final bracket after the sweep, from the archive', async () => {
    /*
     * The summary alone would make the history page honest and the tournament page a 404 — which
     * is the page the history *links to*. The bracket is the one thing here that cannot be
     * reconstructed from the matches: they carry no slot ids and no edges, and these three slots
     * were resolved by the organizer, so they produced no match rows at all.
     */
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')
    await settled((l) => l.find((t) => t.code === created.code)?.complete === true)
    await sweep(created.code)

    const response = await SELF.fetch(`https://example.com/api/tournament/${created.code}`)
    expect(response.status).toBe(200)
    const view = (await response.json()) as {
      archived?: boolean
      champion: string | null
      complete: boolean
      slots: { slot: { id: string }; status: string; winner: string | null }[]
    }
    // Marked, so the page can say it is a record rather than pretend to be watching one.
    expect(view.archived).toBe(true)
    expect(view).toMatchObject({ champion: 't1', complete: true })
    expect(view.slots.map((s) => s.slot.id)).toEqual(['W1M1', 'W1M2', 'W2M1'])
    expect(view.slots.find((s) => s.slot.id === 'W2M1')).toMatchObject({
      status: 'DONE',
      winner: 't1',
    })
  })

  it('does not archive a tournament that never finished', async () => {
    // A bracket half-played and abandoned has no final anything, and inventing a page for it would
    // be showing a result that does not exist. The index still lists it; the bracket is gone.
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await settled((l) => l.some((t) => t.code === created.code))
    await sweep(created.code)

    expect((await SELF.fetch(`https://example.com/api/tournament/${created.code}`)).status).toBe(
      404,
    )
  })

  it('serves a running tournament from the tournament, never from the archive', async () => {
    /*
     * The fallback is for a swept object, not a slow one. A live bracket answered out of the
     * registry would be the one thing on the page that cannot update, and it would look right.
     */
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')
    await settled((l) => l.find((t) => t.code === created.code)?.complete === true)

    const view = (await (
      await SELF.fetch(`https://example.com/api/tournament/${created.code}`)
    ).json()) as { archived?: boolean }
    expect(view.archived).toBeUndefined()
  })

  it('lets go of the archive when a correction unfinishes the tournament', async () => {
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')
    await settled((l) => l.find((t) => t.code === created.code)?.complete === true)

    await SELF.fetch(`https://example.com/api/tournament/${created.code}/correct`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-organizer-key': created.organizerToken,
      },
      body: JSON.stringify({
        slotId: 'W2M1',
        winnerEntrantId: 't2',
        reason: 'reported the wrong way round',
        voidDownstream: true,
      }),
    })
    // The correction refills the final, so this ends complete again with a different champion —
    // what matters is that the archive followed rather than keeping the bracket it was filed with.
    await settled((l) => l.find((t) => t.code === created.code)?.champion === 'Player 2')
    await sweep(created.code)

    const view = (await (
      await SELF.fetch(`https://example.com/api/tournament/${created.code}`)
    ).json()) as { champion: string | null }
    expect(view.champion).toBe('t2')
  })

  it('follows a D39 correction back to unfinished', async () => {
    const created = await createTournament()
    await resolve(created, 'W1M1', 't1')
    await resolve(created, 'W1M2', 't2')
    await resolve(created, 'W2M1', 't1')
    await settled((l) => l.find((t) => t.code === created.code)?.complete === true)

    await SELF.fetch(`https://example.com/api/tournament/${created.code}/correct`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-organizer-key': created.organizerToken,
      },
      body: JSON.stringify({
        slotId: 'W1M1',
        winnerEntrantId: 't4',
        reason: 'reported the wrong way round',
        voidDownstream: true,
      }),
    })

    // The index is an upsert, so a tournament that stops being finished stops saying it is.
    const after = await settled((l) => l.find((t) => t.code === created.code)?.complete === false)
    expect(after.find((t) => t.code === created.code)!.champion).toBeNull()
  })
})

describe('a bracket match is distinguishable in the history', () => {
  it('carries its tournament code, and a casual match carries none', async () => {
    const created = await createTournament({
      config: { format: 'SINGLE_ELIMINATION', default: { modeId: 'bo1-bring3-ban1' } },
    })

    // Play one tournament match for real, so a row reaches the registry the ordinary way.
    const { TestClient, materialize } = await import('./client.js')
    const view = (await (
      await SELF.fetch(`https://example.com/api/tournament/${created.code}`)
    ).json()) as { slots: { slot: { id: string }; roomCode: string | null; entrants: string[] }[] }
    const slot = view.slots.find((s) => s.slot.id === 'W1M1')!
    const tokenOf = (id: string) => created.entrants.find((e) => e.entrantId === id)!.entrantToken

    const a = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[0]!))
    const b = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[1]!))
    await a.connect()
    await b.connect()
    for (let guard = 0; guard < 120; guard++) {
      if (a.view.status === 'COMPLETE') break
      const actor = [a, b].find((c) => c.isAwaited)
      if (!actor) break
      const action = actor
        .actions()
        .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
      await actor.act(materialize(action, actor.seat, 'A'))
    }

    for (let i = 0; i < 60; i++) {
      const body = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
        matches: { roomCode: string; tournamentId?: string }[]
      }
      const row = body.matches.find((m) => m.roomCode === slot.roomCode)
      if (row) {
        // Written since Phase 4 and *read back* since Phase 8 — a field that is stored and never
        // returned is indistinguishable from one nobody needed.
        expect(row.tournamentId).toBe(created.code)
        expect(body.matches.every((m) => m.roomCode === slot.roomCode || !m.tournamentId)).toBe(
          true,
        )
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the tournament match never reached the history')
  })
})
