import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { TestClient, materialize } from './client.js'

/**
 * **D37 Phase 5 — the bracket, live.**
 *
 * Two things are being proved. That a watcher sees a slot resolve without refreshing, which is the
 * feature. And that the frames carry nothing from inside a match in progress, which is the part
 * that would be a security bug rather than a missing feature — asserted against the **raw frames**
 * for the same reason `hidden-select-leak.test.ts` does: §7's rule is that a hidden value is
 * absent from the wire, and an object-level check passes while a `toJSON` leaks.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

interface Created {
  code: string
  organizerToken: string
  entrants: { entrantId: string; entrantToken: string }[]
}

interface BracketFrame {
  entrants: { entrantId: string; displayName: string }[]
  slots: {
    slot: { id: string }
    status: string
    entrants: [string | null, string | null]
    roomCode: string | null
    winner: string | null
  }[]
  champion: string | null
  complete: boolean
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

/** A spectator: no token, no seat, read-only. Returns the raw frames and the parsed ones. */
async function watch(code: string) {
  const response = await SELF.fetch(`https://example.com/api/tournament/${code}/ws`, {
    headers: { Upgrade: 'websocket' },
  })
  if (response.status !== 101) throw new Error(`watch failed: ${response.status}`)
  const socket = response.webSocket!
  const raw: string[] = []
  socket.accept()
  socket.addEventListener('message', (event) => raw.push(String(event.data)))

  return {
    socket,
    raw,
    frames: (): BracketFrame[] =>
      raw.map((r) => (JSON.parse(r) as { view: BracketFrame }).view).filter(Boolean),
    latest: (): BracketFrame | undefined => {
      const all = raw.map((r) => (JSON.parse(r) as { view: BracketFrame }).view)
      return all[all.length - 1]
    },
    async settle(turns = 20) {
      for (let i = 0; i < turns; i++) await scheduler.wait(1)
    },
  }
}

const view = async (code: string) =>
  (await (await SELF.fetch(`https://example.com/api/tournament/${code}`)).json()) as BracketFrame

const slotIn = (v: BracketFrame, id: string) => {
  const found = v.slots.find((s) => s.slot.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}

describe('spectators are first-class', () => {
  it('needs no token, no seat, and nothing else', async () => {
    const created = await createTournament()
    const spectator = await watch(created.code)
    await spectator.settle()

    // A bracket is public for the same reason D31's lobby and D34's history are, and most people
    // looking at one are not playing in it.
    expect(spectator.raw.length).toBeGreaterThan(0)
    expect(spectator.latest()!.slots).toHaveLength(3)
  })

  it('sends the whole bracket on connect, so a reconnect is not a special case', async () => {
    const created = await createTournament()
    const spectator = await watch(created.code)
    await spectator.settle()

    const first = spectator.latest()!
    expect(slotIn(first, 'W1M1').status).toBe('READY')
    expect(first.complete).toBe(false)
    // Matches the HTTP read exactly — one builder, so the two cannot drift.
    expect(first.slots.map((s) => s.slot.id)).toEqual(
      (await view(created.code)).slots.map((s) => s.slot.id),
    )
  })

  it('refuses a non-upgrade request and an unknown code', async () => {
    const created = await createTournament()
    const plain = await SELF.fetch(`https://example.com/api/tournament/${created.code}/ws`)
    expect(plain.status).toBe(426)

    const missing = await SELF.fetch('https://example.com/api/tournament/T-ZZZZZZ/ws', {
      headers: { Upgrade: 'websocket' },
    })
    expect(missing.status).toBe(404)
  })

  it('says the socket is read-only rather than ignoring what it is sent', async () => {
    const created = await createTournament()
    const spectator = await watch(created.code)
    spectator.socket.send(JSON.stringify({ type: 'PROGRESS', filled: 1, of: 3 }))
    await spectator.settle()

    // A silent drop leaves somebody wondering whether their message went anywhere.
    expect(spectator.raw.some((r) => r.includes('read-only'))).toBe(true)
  })
})

describe('the bracket updates without a refresh', () => {
  it('pushes a slot resolving to a watcher who did nothing', async () => {
    const created = await createTournament()
    const spectator = await watch(created.code)
    await spectator.settle()
    const before = spectator.raw.length

    const slot = slotIn(await view(created.code), 'W1M1')
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
      await actor.act(materialize(action, actor.seat, 'A'))
    }

    for (let i = 0; i < 60; i++) {
      await spectator.settle(2)
      const latest = spectator.latest()
      if (latest && slotIn(latest, 'W1M1').winner !== null) {
        expect(spectator.raw.length).toBeGreaterThan(before)
        /*
         * The final is still `PENDING` and roomless, and that is correct rather than a gap in
         * the push: with four entrants `W2M1` needs *both* semi-finals, and only one has been
         * played. Asserted so the next reader does not take a missing room here as a bug — the
         * end-to-end test in `tournament-play` covers the round actually opening.
         */
        expect(slotIn(latest, 'W2M1').status).toBe('PENDING')
        expect(slotIn(latest, 'W2M1').roomCode).toBeNull()
        return
      }
    }
    throw new Error('the watcher never saw the slot resolve')
  })

  it('reaches every watcher, not just the one nearest the change', async () => {
    const created = await createTournament()
    const first = await watch(created.code)
    const second = await watch(created.code)
    await first.settle()
    await second.settle()

    const before = { first: first.raw.length, second: second.raw.length }

    // Any write will do. A relink is the cheapest one that certainly changes something — and it
    // is behind the organizer token since Phase 7, so it needs the key.
    await SELF.fetch(`https://example.com/api/tournament/${created.code}/relink`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-organizer-key': created.organizerToken,
      },
      body: JSON.stringify({ entrantId: 't1', displayName: 'Renamed' }),
    })
    await first.settle()
    await second.settle()

    expect(first.raw.length).toBeGreaterThan(before.first)
    expect(second.raw.length).toBeGreaterThan(before.second)
    for (const spectator of [first, second]) {
      expect(spectator.latest()!.entrants.some((e) => e.displayName === 'Renamed')).toBe(true)
    }
  })

  it('pushes nothing when nothing changed', async () => {
    // A no-op provisioning run is a poke, not a change. Broadcasting on every poke would put
    // traffic on the wire that says the same thing the last frame did.
    const created = await createTournament()
    const spectator = await watch(created.code)
    await spectator.settle()

    const before = spectator.raw.length
    await SELF.fetch(`https://example.com/api/tournament/${created.code}/provision`, {
      method: 'POST',
    })
    await spectator.settle()
    expect(spectator.raw.length).toBe(before)
  })
})

describe('nothing from inside a live match reaches the bracket socket', () => {
  it('carries no drafted character, no ban, and no selection', async () => {
    /*
     * The frames are asserted as **strings**, which is the §7 rule: a hidden value must be absent
     * from the wire rather than present-and-flagged, and an object test passes while a `toJSON`
     * leaks.
     *
     * The guarantee here is structural rather than filtered — a `TournamentView` has no field
     * that could hold match state, so there is nothing to redact. This test exists to keep that
     * true: the day somebody adds "current draft" to the bracket for a nice touch, it fails.
     */
    const created = await createTournament()
    const spectator = await watch(created.code)

    const slot = slotIn(await view(created.code), 'W1M1')
    const tokenOf = (id: string) => created.entrants.find((e) => e.entrantId === id)!.entrantToken
    const a = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[0]!))
    const b = await TestClient.claimSeatWithToken(slot.roomCode!, tokenOf(slot.entrants[1]!))
    await a.connect()
    await b.connect()

    // Drive into the middle of the match, where the bans are sealed and the picks are hidden.
    for (let guard = 0; guard < 20; guard++) {
      if (a.action('REPORT_RESULT')) break
      const actor = [a, b].find((c) => c.isAwaited)
      if (!actor) break
      const action = actor
        .actions()
        .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
      await actor.act(materialize(action, actor.seat, 'A'))
      await spectator.settle(2)
    }

    const wire = spectator.raw.join('')
    expect(wire.length).toBeGreaterThan(0)

    // Every character either side is holding, by id. None of it is the bracket's business.
    const held = [...(a.view.you.slots ?? []), ...(b.view.you.slots ?? [])].map(
      (s) => s.characterId,
    )
    expect(held.length).toBeGreaterThan(0)
    for (const characterId of held) {
      expect(wire, `bracket frame leaked '${characterId}'`).not.toContain(characterId)
    }

    // And none of the vocabulary a match frame is made of.
    for (const field of ['"slots":[{"index"', 'bannedInRound', 'metaBanPlaced', 'legalActions']) {
      expect(wire, `bracket frame leaked '${field}'`).not.toContain(field)
    }
  })

  it('never carries an entrant token', async () => {
    const created = await createTournament()
    const spectator = await watch(created.code)
    await spectator.settle()

    // The credential is returned once at creation and never again — including here, where it
    // would be visible to every spectator at once.
    for (const entrant of created.entrants) {
      expect(spectator.raw.join('')).not.toContain(entrant.entrantToken)
    }
  })
})
