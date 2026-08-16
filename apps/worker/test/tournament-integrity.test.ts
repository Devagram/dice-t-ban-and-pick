import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { TestClient, materialize } from './client.js'

/**
 * **D38 and D39, end to end in workerd.**
 *
 * The engine tests prove the rules. These prove the wiring the engine cannot see: that a
 * tournament match is actually created with `BOTH_SEATS`, that a disagreement reaches the bracket
 * while it is happening, that consuming a result freezes the match that produced it, and that
 * `/admin` refuses to move a result the bracket has already acted on.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

interface Created {
  code: string
  entrants: { entrantId: string; entrantToken: string }[]
}

interface Slot {
  slot: { id: string }
  status: string
  entrants: [string | null, string | null]
  roomCode: string | null
  winner: string | null
}

async function createTournament(over: object = {}): Promise<Created> {
  const response = await SELF.fetch('https://example.com/api/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entrants: people(4),
      config: { format: 'SINGLE_ELIMINATION', default: { modeId: 'bo1-bring3-ban1' } },
      ...over,
    }),
  })
  if (response.status !== 201) throw new Error(await response.text())
  return (await response.json()) as Created
}

const view = async (code: string) =>
  (await (await SELF.fetch(`https://example.com/api/tournament/${code}`)).json()) as {
    slots: Slot[]
  }

const slotIn = (v: { slots: Slot[] }, id: string): Slot => {
  const found = v.slots.find((s) => s.slot.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}

/** Seats both entrants of a slot and drives to the report, returning the connected clients. */
async function toReport(created: Created, slotId: string) {
  const slot = slotIn(await view(created.code), slotId)
  const tokenOf = (id: string) => created.entrants.find((e) => e.entrantId === id)!.entrantToken

  const a = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[0]!))
  const b = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[1]!))
  await a.connect()
  await b.connect()

  for (let guard = 0; guard < 120; guard++) {
    if (a.action('REPORT_RESULT')) break
    const actor = [a, b].find((c) => c.isAwaited)
    if (!actor) throw new Error('nobody can act')
    const action = actor
      .actions()
      .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
    await actor.act(materialize(action, actor.seat, 'A'))
  }
  return { a, b, slot }
}

const sendReport = async (client: TestClient, outcome: 'A' | 'B' | 'TIE') => {
  const action = client.action('REPORT_RESULT')!
  await client.act({
    type: 'REPORT_RESULT',
    moduleId: action.moduleId,
    roundIndex: action.roundIndex,
    reportedBy: client.seat,
    outcome,
  })
}

describe('D38 — a tournament match needs both seats', () => {
  it('is created with BOTH_SEATS, and a casual match is not', async () => {
    const created = await createTournament()
    const room = slotIn(await view(created.code), 'W1M1').roomCode!
    const preview = async (code: string) =>
      (await (await SELF.fetch(`https://example.com/api/match/${code}/preview`)).json()) as {
        ruleset: { resultReporting: string }
      }
    expect((await preview(room)).ruleset.resultReporting).toBe('BOTH_SEATS')

    const casual = (await (
      await SELF.fetch('https://example.com/api/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modeId: 'base', parameters: { draftCount: 4 } }),
      })
    ).json()) as { roomCode: string }
    // D15, unchanged, for everything nobody put in a bracket.
    expect((await preview(casual.roomCode)).ruleset.resultReporting).toBe('ONE_SIDED')
  })

  it('does not complete the match on one report', async () => {
    const created = await createTournament()
    const { a, b } = await toReport(created, 'W1M1')

    await sendReport(a, 'A')
    await a.settle(10)

    expect(a.view.status).toBe('IN_PROGRESS')
    // And the other seat is asked to confirm, with what it is confirming.
    expect(b.action('REPORT_RESULT')?.confirming).toBe('A')
  })

  it('completes when the second seat agrees, and the bracket advances', async () => {
    const created = await createTournament()
    const { a, b, slot } = await toReport(created, 'W1M1')

    await sendReport(a, 'A')
    await sendReport(b, 'A')
    await a.settle(20)
    expect(a.view.status).toBe('COMPLETE')

    for (let i = 0; i < 40; i++) {
      const after = await view(created.code)
      if (slotIn(after, 'W1M1').winner !== null) {
        expect(slotIn(after, 'W1M1').winner).toBe(slot.entrants[0])
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the agreed result never reached the bracket')
  })

  it('surfaces a disagreement to the bracket while it is still happening', async () => {
    /*
     * A disputed round never resolves, so waiting for the match to complete would mean the
     * organizer never hears about it. The slot has to say `DISPUTED` while two people are arguing,
     * not afterwards — there is no afterwards.
     */
    const created = await createTournament()
    const { a, b } = await toReport(created, 'W1M1')

    await sendReport(a, 'A')
    await sendReport(b, 'B')
    await a.settle(20)

    for (let i = 0; i < 40; i++) {
      const after = await view(created.code)
      if (slotIn(after, 'W1M1').status === 'DISPUTED') {
        expect(slotIn(after, 'W1M1').winner).toBeNull()
        // The other half of the bracket is unaffected.
        expect(slotIn(after, 'W1M2').status).toBe('READY')
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the dispute never reached the bracket')
  })
})

describe('D39 — consuming a result freezes the match that produced it', () => {
  it('takes the undo away from the players, and says why', async () => {
    const created = await createTournament()
    const { a, b } = await toReport(created, 'W1M1')

    await sendReport(a, 'A')
    await sendReport(b, 'A')

    for (let i = 0; i < 60; i++) {
      await a.settle(5)
      if (a.view.frozen) {
        // The reason travels with it — a control that silently stops appearing is worse than one
        // that explains itself.
        expect(a.view.frozen.reason).toContain('bracket')
        expect(a.actions().map((x) => x.type)).not.toContain('UNDO_LAST_RESULT')
        expect(b.view.frozen).not.toBeNull()
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the match was never frozen')
  })
})

describe('D34’s admin edit cannot move a bracket behind its back', () => {
  it('refuses a tournament match and points at the tournament', async () => {
    const created = await createTournament()
    const { a, b } = await toReport(created, 'W1M1')
    const room = slotIn(await view(created.code), 'W1M1').roomCode!

    await sendReport(a, 'A')
    await sendReport(b, 'A')
    await a.settle(20)

    // Wait for the row to reach the registry.
    for (let i = 0; i < 60; i++) {
      const matches = (await (await SELF.fetch('https://example.com/api/matches')).json()) as {
        matches: { roomCode: string }[]
      }
      if (matches.matches.some((m) => m.roomCode === room)) break
      await scheduler.wait(1)
    }

    const response = await SELF.fetch('https://example.com/api/admin/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': String(env.ADMIN_KEY) },
      body: JSON.stringify({ roomCode: room, winnerId: 'B' }),
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string; detail: string }
    // Two truths, and the stale one is always the one nobody is looking at.
    expect(body.error).toBe('TOURNAMENT_MATCH')
    expect(body.detail).toContain(created.code)
  })

  it('still edits an ordinary match, exactly as D34 wrote it', async () => {
    const casual = (await (
      await SELF.fetch('https://example.com/api/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modeId: 'base', parameters: { draftCount: 4 } }),
      })
    ).json()) as { roomCode: string }

    // Not played, so not in the registry — a 404 rather than a 409 is the proof that the refusal
    // above is about the tournament binding and not about admin edits in general.
    const response = await SELF.fetch('https://example.com/api/admin/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': String(env.ADMIN_KEY) },
      body: JSON.stringify({ roomCode: casual.roomCode, winnerId: 'B' }),
    })
    expect(response.status).toBe(404)
  })
})
