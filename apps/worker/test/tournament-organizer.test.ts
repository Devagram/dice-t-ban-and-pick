import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * **D37 Phase 7 — the organizer console's server half.**
 *
 * The first thing this phase closes is a hole that has been flagged in the plan since Phase 3:
 * `relink` and `provision` were reachable by anybody with a tournament code. The gate test below
 * walks **every** mutating route rather than a sample, because the failure mode of a per-route
 * check is forgetting one, and a forgotten one is silent — the endpoint simply works for
 * everybody.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

interface Created {
  code: string
  organizerToken: string
  entrants: { entrantId: string; entrantToken: string }[]
}

interface Slot {
  slot: { id: string }
  status: string
  entrants: [string | null, string | null]
  winner: string | null
  roomCode: string | null
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

const view = async (code: string) =>
  (await (await SELF.fetch(`https://example.com/api/tournament/${code}`)).json()) as {
    slots: Slot[]
    champion: string | null
  }

const slotIn = (v: { slots: Slot[] }, id: string): Slot => {
  const found = v.slots.find((s) => s.slot.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}

const asOrganizer = (created: Created, action: string, body: unknown): Promise<Response> =>
  SELF.fetch(`https://example.com/api/tournament/${created.code}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-organizer-key': created.organizerToken,
    },
    body: JSON.stringify(body),
  })

/** Records a winner for a slot the honest way, so the tests below have something to correct. */
async function settle(created: Created, slotId: string, winner: string): Promise<void> {
  const response = await asOrganizer(created, 'resolve', {
    slotId,
    winnerEntrantId: winner,
    reason: 'walkover in test setup',
  })
  if (!response.ok) throw new Error(`resolve failed: ${await response.text()}`)
}

describe('the organizer door', () => {
  /** Every route that changes something. Listed here, and asserted against the router. */
  const MUTATIONS = ['provision', 'relink', 'resolve', 'voidSlot', 'correct', 'reseed', 'entrants']

  it.each(MUTATIONS)('refuses %s without a key', async (action) => {
    const created = await createTournament()
    const response = await SELF.fetch(
      `https://example.com/api/tournament/${created.code}/${action}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toBe('UNAUTHORIZED')
  })

  it.each(MUTATIONS)('refuses %s with the wrong key', async (action) => {
    const created = await createTournament()
    const response = await SELF.fetch(
      `https://example.com/api/tournament/${created.code}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-organizer-key': 'f'.repeat(64) },
        body: '{}',
      },
    )
    expect(response.status).toBe(401)
  })

  it('is not the deployment-wide admin key', async () => {
    // D34's key gates rewriting *everyone's* history. Running Thursday's tournament should not
    // require it, and handing it out so somebody can is how it leaks.
    const created = await createTournament()
    const response = await SELF.fetch(
      `https://example.com/api/tournament/${created.code}/provision`,
      {
        method: 'POST',
        headers: { 'x-admin-key': 'test-admin-key', 'x-organizer-key': 'test-admin-key' },
      },
    )
    expect(response.status).toBe(401)
  })

  it('leaves reads open, because a bracket is public', async () => {
    const created = await createTournament()
    expect((await SELF.fetch(`https://example.com/api/tournament/${created.code}`)).status).toBe(
      200,
    )
    const cascade = await SELF.fetch(`https://example.com/api/tournament/${created.code}/cascade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotId: 'W1M1' }),
    })
    expect(cascade.status).toBe(200)
  })

  it('hands the token back exactly once', async () => {
    const created = await createTournament()
    expect(created.organizerToken).toMatch(/^[0-9a-f]{64}$/)
    // Only its hash is stored, so no later read can recover it — the same contract D17 gives a
    // seat token and D41 gives an entrant one.
    const frame = JSON.stringify(await view(created.code))
    expect(frame).not.toContain(created.organizerToken)
  })
})

describe('settling a slot the players could not', () => {
  it('resolves a dispute, a draw and a no-show through one action', async () => {
    // Three situations, one act — *the organizer has decided this* — and the reason is what
    // distinguishes them, so the reason is what gets recorded.
    const created = await createTournament()
    const entrantId = slotIn(await view(created.code), 'W1M1').entrants[0]!

    const response = await asOrganizer(created, 'resolve', {
      slotId: 'W1M1',
      winnerEntrantId: entrantId,
      reason: 'opponent did not turn up',
    })
    expect(response.status).toBe(200)
    expect(slotIn(await view(created.code), 'W1M1').winner).toBe(entrantId)
  })

  it('refuses to record a decision with no reason', async () => {
    // A forced advancement with no reason is indistinguishable a week later from one somebody
    // made up, and this is the log people will argue over.
    const created = await createTournament()
    const entrantId = slotIn(await view(created.code), 'W1M1').entrants[0]!
    const response = await asOrganizer(created, 'resolve', {
      slotId: 'W1M1',
      winnerEntrantId: entrantId,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('REASON_REQUIRED')
  })

  it('refuses to crown somebody who is not in the slot', async () => {
    const created = await createTournament()
    const response = await asOrganizer(created, 'resolve', {
      slotId: 'W1M1',
      winnerEntrantId: 't3',
      reason: 'wrong half of the bracket',
    })
    expect(response.status).toBe(400)
  })

  it('voids a slot and opens a fresh room for the re-run', async () => {
    const created = await createTournament()
    const before = slotIn(await view(created.code), 'W1M1').roomCode

    const response = await asOrganizer(created, 'voidSlot', {
      slotId: 'W1M1',
      reason: 'wrong ruleset agreed at the table',
    })
    expect(response.status).toBe(200)

    const after = slotIn(await view(created.code), 'W1M1')
    expect(after.status).toBe('VOIDED')
    // A re-run in the room that produced the voided result would replay into the same match log.
    expect(after.roomCode).not.toBe(before)
  })
})

describe('D39 — correcting a consumed result', () => {
  it('shows the cascade before anything is applied, split by whether it was played', async () => {
    const created = await createTournament()
    await settle(created, 'W1M1', 't1')
    await settle(created, 'W1M2', 't2')
    await settle(created, 'W2M1', 't1')

    const cascade = (await (
      await SELF.fetch(`https://example.com/api/tournament/${created.code}/cascade`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slotId: 'W1M1' }),
      })
    ).json()) as { played: string[]; pending: string[] }

    // The final was played, so whether it still counts is a judgement about the evening — the
    // split is what lets the console ask rather than decide.
    expect(cascade.played).toContain('W2M1')
    expect(cascade.pending).toEqual([])
  })

  it('re-derives the bracket, leaving the played downstream match for the organizer', async () => {
    const created = await createTournament()
    await settle(created, 'W1M1', 't1')
    await settle(created, 'W1M2', 't2')
    await settle(created, 'W2M1', 't1')

    const corrected = await asOrganizer(created, 'correct', {
      slotId: 'W1M1',
      winnerEntrantId: 't4',
      reason: 'reported the wrong way round',
    })
    expect(corrected.status).toBe(200)
    expect(((await corrected.json()) as { voided: string[] }).voided).toEqual([])

    const after = await view(created.code)
    expect(slotIn(after, 'W1M1').winner).toBe('t4')
    // The final still holds its old result, and now describes a match between people who did not
    // both get there. Surfaced rather than silently rewritten — that is the whole of D39.
    expect(slotIn(after, 'W2M1').winner).toBe('t1')
  })

  it('voids the played downstream matches when the organizer says so', async () => {
    const created = await createTournament()
    await settle(created, 'W1M1', 't1')
    await settle(created, 'W1M2', 't2')
    await settle(created, 'W2M1', 't1')

    const corrected = await asOrganizer(created, 'correct', {
      slotId: 'W1M1',
      winnerEntrantId: 't4',
      reason: 'reported the wrong way round',
      voidDownstream: true,
    })
    expect(((await corrected.json()) as { voided: string[] }).voided).toEqual(['W2M1'])

    const after = await view(created.code)
    expect(slotIn(after, 'W1M1').winner).toBe('t4')
    expect(after.champion).toBeNull()
    // And it re-opens as a real match between the people who actually got there.
    expect(slotIn(after, 'W2M1').entrants).toEqual(['t4', 't2'])
  })
})

describe('seeding and substitutions', () => {
  it('re-seeds before the first match', async () => {
    const created = await createTournament()
    const response = await asOrganizer(created, 'reseed', { order: ['t4', 't3', 't2', 't1'] })
    expect(response.status).toBe(200)

    // Seed 1 plays seed 4, so reversing the order reverses who meets whom.
    expect(slotIn(await view(created.code), 'W1M1').entrants).toEqual(['t4', 't1'])
  })

  it('refuses to re-seed once anything has been played', async () => {
    // After a result it is not a re-seed, it is rebuilding the bracket around games people have
    // already played — which would move a winner into a slot they never played.
    const created = await createTournament()
    await settle(created, 'W1M1', 't1')

    const response = await asOrganizer(created, 'reseed', { order: ['t4', 't3', 't2', 't1'] })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe('ALREADY_STARTED')
  })

  it('refuses an order that is not exactly the entrant list', async () => {
    const created = await createTournament()
    expect((await asOrganizer(created, 'reseed', { order: ['t1', 't2'] })).status).toBe(400)
    expect(
      (await asOrganizer(created, 'reseed', { order: ['t1', 't2', 't3', 'nope'] })).status,
    ).toBe(400)
  })

  it('substitutes an entrant, and the departing one’s token stops working', async () => {
    const created = await createTournament()
    const room = slotIn(await view(created.code), 'W1M1').roomCode!
    const old = created.entrants.find((e) => e.entrantId === 't1')!.entrantToken

    const response = await asOrganizer(created, 'entrants', {
      entrantId: 't1',
      playerId: 'p_substitute',
      displayName: 'Substitute',
    })
    expect(response.status).toBe(200)
    const fresh = ((await response.json()) as { entrantToken: string }).entrantToken

    const seat = (token: string) =>
      SELF.fetch(`https://example.com/api/match/${room}/seat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'p_substitute', displayName: 'Sub', entrantToken: token }),
      })

    // It is a different person: the one the departing entrant holds must stop at the same moment.
    expect((await seat(old)).status).toBe(403)
    expect((await seat(fresh)).status).toBe(201)
  })

  it('needs all three fields, because a substitution replaces a person', async () => {
    const created = await createTournament()
    expect((await asOrganizer(created, 'entrants', { entrantId: 't1' })).status).toBe(400)
  })
})
