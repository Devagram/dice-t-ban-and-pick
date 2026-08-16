import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { TestClient, materialize } from './client.js'

/**
 * **D37 Phase 3 — provisioning, assigned seats, and a whole tournament played in workerd.**
 *
 * The engine tests prove the rules and the bracket tests prove the routing. This proves the parts
 * neither can reach: rooms opened from ready slots, D41's entrant token deciding who sits where,
 * and a result travelling from a real socket back into the bracket.
 */

interface Created {
  code: string
  organizerToken: string
  entrants: { entrantId: string; displayName: string; seed: number; entrantToken: string }[]
}

interface Slot {
  slot: { id: string }
  status: string
  entrants: [string | null, string | null]
  roomCode: string | null
  modeId: string
  winner: string | null
}

interface View {
  slots: Slot[]
  champion: string | null
  complete: boolean
}

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

async function createTournament(body: unknown): Promise<Created> {
  const response = await SELF.fetch('https://example.com/api/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (response.status !== 201) throw new Error(`create failed: ${await response.text()}`)
  return (await response.json()) as Created
}

const view = async (code: string): Promise<View> =>
  (await (await SELF.fetch(`https://example.com/api/tournament/${code}`)).json()) as View

const slotIn = (v: View, id: string): Slot => {
  const found = v.slots.find((s) => s.slot.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}

/**
 * Reads the bracket until it reaches a state, rather than assuming it is already there.
 *
 * Two deliberate asynchronies sit between a match ending and the next room existing, and both are
 * things to wait *for* rather than around: `MatchDO` reports the result on a `waitUntil` so no
 * player waits for the bracket, and `report` records the result before it opens what that
 * unlocked — so a read can legitimately land in between and see an advanced bracket with the next
 * room still missing. Polling here is the test agreeing with that design.
 */
async function until(code: string, ready: (v: View) => boolean, what = 'state'): Promise<View> {
  let last: View | null = null
  for (let i = 0; i < 100; i++) {
    last = await view(code)
    if (ready(last)) return last
    await scheduler.wait(1)
  }
  throw new Error(`the bracket never reached ${what}; last: ${JSON.stringify(last?.slots)}`)
}

/** Claims a seat in a tournament match with an entrant token, as the client will. */
async function seat(roomCode: string, playerId: string, entrantToken?: string): Promise<Response> {
  return SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      displayName: playerId,
      ...(entrantToken === undefined ? {} : { entrantToken }),
    }),
  })
}

describe('provisioning', () => {
  it('opens a room for every ready slot the moment the tournament exists', async () => {
    const created = await createTournament({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION' },
    })
    const v = await view(created.code)

    // Round one is ready; the final is not, so it has no room yet.
    expect(slotIn(v, 'W1M1').roomCode).toMatch(/^[0-9A-Z]{6}$/)
    expect(slotIn(v, 'W1M2').roomCode).toMatch(/^[0-9A-Z]{6}$/)
    expect(slotIn(v, 'W2M1').roomCode).toBeNull()
    expect(slotIn(v, 'W1M1').roomCode).not.toBe(slotIn(v, 'W1M2').roomCode)
  })

  it('opens each room under the mode its bracket position calls for', async () => {
    const created = await createTournament({
      entrants: people(4),
      config: {
        format: 'DOUBLE_ELIMINATION',
        default: { modeId: 'base', parameters: { draftCount: 4 } },
        overrides: { LOSERS: { modeId: 'bo1-bring3-ban1' } },
      },
    })
    const v = await view(created.code)
    const preview = async (code: string) =>
      (await (await SELF.fetch(`https://example.com/api/match/${code}/preview`)).json()) as {
        ruleset: { modeId: string }
      }

    // The room really was created under the winners-bracket mode — read back off the match, not
    // off the tournament's own idea of it.
    expect((await preview(slotIn(v, 'W1M1').roomCode!)).ruleset.modeId).toBe('base')
  })

  it('keeps tournament rooms out of the open lobby list (D31)', async () => {
    const created = await createTournament({ entrants: people(4) })
    const v = await view(created.code)
    const rooms = (await (await SELF.fetch('https://example.com/api/lobbies')).json()) as {
      rooms: { roomCode: string }[]
    }
    const listed = new Set(rooms.rooms.map((r) => r.roomCode))
    // A listed room is an invitation, and only two named people may take this one.
    for (const slot of v.slots) {
      if (slot.roomCode) expect(listed.has(slot.roomCode)).toBe(false)
    }
  })

  it('refuses a tournament binding asked for from outside', async () => {
    // The field turns off open seating and hides the room. A client that could set one could mint
    // itself a private room claiming to belong to somebody's event.
    const response = await SELF.fetch('https://example.com/api/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modeId: 'base',
        parameters: { draftCount: 4 },
        tournament: { code: 'T-AAAAAA', slotId: 'W1M1' },
      }),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('TOURNAMENT_BINDING_REFUSED')
  })
})

describe('D41 — assigned seats', () => {
  it('seats the two entrants in the seats the bracket gave them', async () => {
    const created = await createTournament({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION' },
    })
    const v = await view(created.code)
    const room = slotIn(v, 'W1M1').roomCode!
    const [first, second] = slotIn(v, 'W1M1').entrants
    const tokenOf = (entrantId: string) =>
      created.entrants.find((e) => e.entrantId === entrantId)!.entrantToken

    const a = (await (await seat(room, 'p1', tokenOf(first!))).json()) as { seat: string }
    const b = (await (await seat(room, 'p4', tokenOf(second!))).json()) as { seat: string }
    // Assigned, not first-come: the bracket's first side is seat A whichever order they arrive in.
    expect(a.seat).toBe('A')
    expect(b.seat).toBe('B')
  })

  it('lets an entrant in from a browser with a different player id', async () => {
    /*
     * D41's whole purpose, and the case a player-id gate would have failed. A player id belongs to
     * a browser (D35), so somebody opening their match on a phone is a different id — and still
     * the same entrant.
     */
    const created = await createTournament({ entrants: people(4) })
    const v = await view(created.code)
    const room = slotIn(v, 'W1M1').roomCode!
    const entrantId = slotIn(v, 'W1M1').entrants[0]!
    const token = created.entrants.find((e) => e.entrantId === entrantId)!.entrantToken

    const response = await seat(room, 'p_a_completely_different_browser', token)
    expect(response.status).toBe(201)

    // And the seat is filled under the entrant's *registered* identity, so the bracket and the
    // leaderboard cannot end up describing two different people.
    const preview = (await (
      await SELF.fetch(`https://example.com/api/match/${room}/preview`)
    ).json()) as { seatsAvailable: string[] }
    expect(preview.seatsAvailable).toEqual(['B'])
  })

  it('turns away somebody who is not in the match, and says which kind of no it is', async () => {
    const created = await createTournament({ entrants: people(4) })
    const v = await view(created.code)
    const room = slotIn(v, 'W1M1').roomCode!

    // No token at all.
    const bare = await seat(room, 'p_stranger')
    expect(bare.status).toBe(403)
    expect(((await bare.json()) as { error: string }).error).toBe('ENTRANT_TOKEN_REQUIRED')

    // A token this tournament has never issued.
    const bogus = await seat(room, 'p_stranger', 'f'.repeat(64))
    expect(((await bogus.json()) as { error: string }).error).toBe('UNKNOWN_TOKEN')

    // A real entrant — of a different match. Distinguished on purpose: "that link is not for this
    // tournament" and "that link is for a different match" send somebody to look in two places.
    const otherSlot = slotIn(v, 'W1M2').entrants[0]!
    const otherToken = created.entrants.find((e) => e.entrantId === otherSlot)!.entrantToken
    const wrongMatch = await seat(room, 'p3', otherToken)
    expect(((await wrongMatch.json()) as { error: string }).error).toBe('NOT_IN_MATCH')
  })

  it('leaves ordinary matches first-come, exactly as D31 wants them', async () => {
    const created = (await (
      await SELF.fetch('https://example.com/api/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modeId: 'base', parameters: { draftCount: 4 } }),
      })
    ).json()) as { roomCode: string }

    // No token, no invitation, no refusal. The open lobby is open on purpose.
    expect((await seat(created.roomCode, 'p_anyone')).status).toBe(201)
  })
})

describe('a drawn tournament match', () => {
  it('is recorded as DRAWN and advances nobody', async () => {
    /*
     * A gap the plan did not anticipate, found while wiring this up. D36's Bo1 allows a tied
     * single round and D21 makes a level match a legal terminal state, so a tournament using
     * either can produce a match with no winner. Reported rather than swallowed: a bracket that
     * silently ignored it would stall with nothing anywhere saying why.
     */
    const created = await createTournament({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION', default: { modeId: 'bo1-bring3-ban1' } },
    })
    const v = await view(created.code)
    const slot = slotIn(v, 'W1M1')
    const tokenOf = (id: string) => created.entrants.find((e) => e.entrantId === id)!.entrantToken

    const a = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[0]!))
    const b = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[1]!))
    await a.connect()
    await b.connect()

    for (let guard = 0; guard < 120; guard++) {
      if (a.view.status === 'COMPLETE') break
      const actor = [a, b].find((c) => c.isAwaited)
      if (!actor) throw new Error('nobody can act')
      const action = actor
        .actions()
        .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
      // 'TIE' where the round accepts it; the driver falls back to 'A' everywhere else.
      await actor.act(materialize(action, actor.seat, 'TIE'))
    }
    expect(a.view.outcome).toBe('DRAW')

    for (let i = 0; i < 40; i++) {
      const after = await view(created.code)
      if (slotIn(after, 'W1M1').status === 'DRAWN') {
        // The bracket knows, and refuses to guess who goes through.
        expect(slotIn(after, 'W1M1').winner).toBeNull()
        expect(slotIn(after, 'W2M1').status).toBe('PENDING')
        expect(slotIn(after, 'W2M1').roomCode).toBeNull()
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the draw never reached the bracket')
  })
})

describe('D41 — relinking an entrant', () => {
  it('re-mints a token, and the old one stops working everywhere at once', async () => {
    const created = await createTournament({ entrants: people(4) })
    const v = await view(created.code)
    const room = slotIn(v, 'W1M1').roomCode!
    const entrantId = slotIn(v, 'W1M1').entrants[0]!
    const oldToken = created.entrants.find((e) => e.entrantId === entrantId)!.entrantToken

    const relinked = (await (
      await SELF.fetch(`https://example.com/api/tournament/${created.code}/relink`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Phase 7 — every mutation is behind the organizer token now.
          'x-organizer-key': created.organizerToken,
        },
        body: JSON.stringify({ entrantId, playerId: 'p_new_device' }),
      })
    ).json()) as { entrantToken: string }

    // Authorisation is asked live rather than snapshotted into the match, which is exactly why a
    // room that was already open picks this up with no re-provisioning.
    expect((await seat(room, 'p_new_device', oldToken)).status).toBe(403)
    expect((await seat(room, 'p_new_device', relinked.entrantToken)).status).toBe(201)
  })
})

describe('the Phase 3 exit criterion', () => {
  it('plays a whole 4-entrant single-elimination tournament over real sockets', async () => {
    const created = await createTournament({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION', default: { modeId: 'bo1-bring3-ban1' } },
    })
    const tokenOf = (entrantId: string) =>
      created.entrants.find((e) => e.entrantId === entrantId)!.entrantToken

    /** Plays the slot's match to completion, with the first-named entrant winning. */
    const playSlot = async (slotId: string): Promise<string> => {
      const v = await until(
        created.code,
        (x) => slotIn(x, slotId).status === 'READY' && slotIn(x, slotId).roomCode !== null,
        `${slotId} ready with a room`,
      )
      const slot = slotIn(v, slotId)
      const room = slot.roomCode

      const [firstId, secondId] = slot.entrants
      const a = await TestClient.claimSeatWithToken(room!, tokenOf(firstId!))
      const b = await TestClient.claimSeatWithToken(room!, tokenOf(secondId!))
      await a.connect()
      await b.connect()

      // Drive both seats through the whole mode, letting seat A take every round.
      for (let guard = 0; guard < 120; guard++) {
        if (a.view.status === 'COMPLETE') break
        const actor = [a, b].find((c) => c.isAwaited)
        if (!actor) throw new Error(`nobody can act in ${slotId}`)
        const action = actor
          .actions()
          .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
        await actor.act(materialize(action, actor.seat, 'A'))
      }
      expect(a.view.status).toBe('COMPLETE')
      a.kill()
      b.kill()
      return firstId!
    }

    const semiOne = await playSlot('W1M1')
    const semiTwo = await playSlot('W1M2')

    // The bracket advanced on a result that came off a socket, and opened the final.
    const afterSemis = await until(
      created.code,
      (v) => slotIn(v, 'W2M1').roomCode !== null,
      'an open final',
    )
    expect(slotIn(afterSemis, 'W1M1').winner).toBe(semiOne)
    expect(slotIn(afterSemis, 'W1M2').winner).toBe(semiTwo)
    expect(slotIn(afterSemis, 'W2M1').entrants).toEqual([semiOne, semiTwo])

    const winner = await playSlot('W2M1')

    const done = await until(created.code, (v) => v.complete, 'a finished tournament')
    expect(done.champion).toBe(winner)
  })
})
