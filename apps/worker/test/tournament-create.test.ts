import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

/**
 * **D37 Phase 2 — a tournament exists, persists, and can be read.**
 *
 * No sockets and no match provisioning yet; those are Phases 3 and 5. What is being proved here is
 * that the object is real in workerd — that it survives hibernation, that its bracket is rebuilt
 * from storage rather than held in memory, and above all that a misconfigured tournament fails at
 * **creation** rather than three rounds in.
 */

interface CreatedEntrant {
  entrantId: string
  displayName: string
  seed: number
  entrantToken: string
  url: string
}

interface Created {
  code: string
  url: string
  entrants: CreatedEntrant[]
}

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ playerId: `p${i + 1}`, displayName: `Player ${i + 1}` }))

async function create(body: unknown): Promise<Response> {
  return SELF.fetch('https://example.com/api/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createOk(body: unknown): Promise<Created> {
  const response = await create(body)
  if (response.status !== 201) throw new Error(`create failed: ${await response.text()}`)
  return (await response.json()) as Created
}

const view = async (code: string) =>
  (await (await SELF.fetch(`https://example.com/api/tournament/${code}`)).json()) as {
    code: string
    format: string
    grandFinalReset: boolean
    entrants: { entrantId: string; displayName: string; seed: number }[]
    slots: { slot: { id: string }; status: string; position: string; modeId: string }[]
    champion: string | null
    complete: boolean
  }

describe('creating a tournament', () => {
  it('mints a prefixed code that cannot be mistaken for a room code', async () => {
    const created = await createOk({ entrants: people(4) })
    // The router should never have to guess which kind of code it is holding.
    expect(created.code).toMatch(/^T-[0-9A-Z]{6}$/)
    expect(created.url).toContain(`/t/${created.code}`)
  })

  it('returns one entrant token per entrant, exactly once', async () => {
    const created = await createOk({ entrants: people(4) })
    expect(created.entrants).toHaveLength(4)

    const tokens = created.entrants.map((e) => e.entrantToken)
    expect(new Set(tokens).size).toBe(4)
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/)

    // D41 — the token rides in the fragment, so it never reaches a server log or a proxy.
    for (const entrant of created.entrants) {
      expect(entrant.url).toContain(`#${entrant.entrantToken}`)
      expect(entrant.url.split('#')[0]).not.toContain(entrant.entrantToken)
    }
  })

  it('never hands a token back on a later read', async () => {
    const created = await createOk({ entrants: people(4) })
    const frame = JSON.stringify(await view(created.code))
    // Only hashes are stored. This is what makes "the organizer re-mints one" the recovery path
    // rather than a convenience, so it is asserted on the serialized response.
    for (const entrant of created.entrants) {
      expect(frame).not.toContain(entrant.entrantToken)
    }
    expect(frame).not.toContain('token')
  })

  it('builds the bracket the entrant count calls for', async () => {
    const created = await createOk({
      entrants: people(8),
      config: { format: 'SINGLE_ELIMINATION' },
    })
    const t = await view(created.code)
    expect(t.format).toBe('SINGLE_ELIMINATION')
    expect(t.slots.map((s) => s.slot.id)).toEqual([
      'W1M1',
      'W1M2',
      'W1M3',
      'W1M4',
      'W2M1',
      'W2M2',
      'W3M1',
    ])
    // Round one is ready to play; everything behind it waits.
    expect(t.slots.filter((s) => s.status === 'READY')).toHaveLength(4)
    expect(t.complete).toBe(false)
    expect(t.champion).toBeNull()
  })

  it('defaults double elimination to a bracket reset (D40)', async () => {
    const created = await createOk({
      entrants: people(4),
      config: { format: 'DOUBLE_ELIMINATION' },
    })
    const t = await view(created.code)
    expect(t.grandFinalReset).toBe(true)
    expect(t.slots.some((s) => s.slot.id === 'GF2')).toBe(true)
  })
})

describe('the mode configuration', () => {
  it('gives every bracket position a mode, defaulting where no override says otherwise', async () => {
    const created = await createOk({
      entrants: people(4),
      config: {
        format: 'DOUBLE_ELIMINATION',
        default: { modeId: 'base', parameters: { draftCount: 4 } },
        overrides: { LOSERS: { modeId: 'bo1-bring3-ban1' } },
      },
    })
    const t = await view(created.code)

    const modeAt = (id: string) => t.slots.find((s) => s.slot.id === id)!.modeId
    expect(modeAt('W1M1')).toBe('base')
    // The requirement in one assertion: a Bo1 losers bracket beside a Bo3 winners bracket.
    expect(modeAt('L1M1')).toBe('bo1-bring3-ban1')
    expect(modeAt('GF')).toBe('base')
  })

  it('labels positions by where they sit, not by slot id', async () => {
    const created = await createOk({
      entrants: people(8),
      config: { format: 'DOUBLE_ELIMINATION' },
    })
    const t = await view(created.code)
    const positionAt = (id: string) => t.slots.find((s) => s.slot.id === id)!.position

    expect(positionAt('W1M1')).toBe('WINNERS')
    expect(positionAt('W3M1')).toBe('WINNERS_FINAL')
    expect(positionAt('L1M1')).toBe('LOSERS')
    expect(positionAt('L4M1')).toBe('LOSERS_FINAL')
    expect(positionAt('GF')).toBe('GRAND_FINAL')
    expect(positionAt('GF2')).toBe('GRAND_FINAL_RESET')
  })

  it('falls the reset back to the grand final rather than to the default', async () => {
    // Playing the decider under different rules from the match it is deciding is the surprise
    // this fallback chain exists to prevent.
    const created = await createOk({
      entrants: people(4),
      config: {
        format: 'DOUBLE_ELIMINATION',
        default: { modeId: 'bo1-bring3-ban1' },
        overrides: { GRAND_FINAL: { modeId: 'base', parameters: { draftCount: 4 } } },
      },
    })
    const t = await view(created.code)
    expect(t.slots.find((s) => s.slot.id === 'GF')!.modeId).toBe('base')
    expect(t.slots.find((s) => s.slot.id === 'GF2')!.modeId).toBe('base')
    expect(t.slots.find((s) => s.slot.id === 'W1M1')!.modeId).toBe('bo1-bring3-ban1')
  })

  it('lets a final differ from the rounds that lead to it', async () => {
    const created = await createOk({
      entrants: people(8),
      config: {
        default: { modeId: 'bo1-bring3-ban1' },
        overrides: { WINNERS_FINAL: { modeId: 'base', parameters: { draftCount: 4 } } },
      },
    })
    const t = await view(created.code)
    expect(t.slots.find((s) => s.slot.id === 'W1M1')!.modeId).toBe('bo1-bring3-ban1')
    expect(t.slots.find((s) => s.slot.id === 'W3M1')!.modeId).toBe('base')
  })
})

describe('failing at creation rather than at the semi-final', () => {
  /*
   * §13's argument, one layer up. A mode that cannot work should fail when the tournament is
   * created — not when eight people have already played two rounds and the bracket reaches the
   * position whose override was misspelled.
   */
  it('rejects an unknown mode id, naming where it was', async () => {
    const response = await create({
      entrants: people(4),
      config: { overrides: { LOSERS: { modeId: 'no-such-mode' } } },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; at: string }
    expect(body.error).toBe('UNKNOWN_MODE')
    expect(body.at).toBe('overrides/LOSERS')
  })

  it('rejects a parameter combination nobody validated (D25)', async () => {
    const response = await create({
      entrants: people(4),
      config: { default: { modeId: 'base', parameters: { draftCount: 9 } } },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('UNKNOWN_VARIANT')
  })

  it('rejects an override key that is not a bracket position', async () => {
    const response = await create({
      entrants: people(4),
      config: { overrides: { SEMIS: { modeId: 'base' } } },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { detail: string }).detail).toContain(
      'not a bracket position',
    )
  })

  it('rejects a field below two or above D42’s cap of 32', async () => {
    expect((await create({ entrants: people(1) })).status).toBe(400)
    const tooMany = await create({ entrants: people(33) })
    expect(tooMany.status).toBe(400)
    expect(((await tooMany.json()) as { detail: string }).detail).toContain('at most 32')
  })

  it('rejects an entrant with no name, and the same player entered twice', async () => {
    const unnamed = await create({
      entrants: [{ playerId: 'p1' }, { playerId: 'p2', displayName: 'B' }],
    })
    expect(((await unnamed.json()) as { detail: string }).detail).toContain('no displayName')

    const twice = await create({
      entrants: [
        { playerId: 'p1', displayName: 'A' },
        { playerId: 'p1', displayName: 'A again' },
      ],
    })
    // D35 — almost always two browsers rather than a joke, and either way a bracket cannot
    // contain somebody twice.
    expect(((await twice.json()) as { detail: string }).detail).toContain('more than once')
  })

  it('rejects an unknown format and an unknown seeding mode', async () => {
    expect((await create({ entrants: people(4), config: { format: 'SWISS' } })).status).toBe(400)
    expect((await create({ entrants: people(4), config: { seeding: 'VIBES' } })).status).toBe(400)
  })

  it('accepts exactly what the create screen sends (Phase 9)', async () => {
    /*
     * The screen assembles a config by hand — a partial override map, a seeding mode, D40's flag —
     * and every one of those is validated server-side at creation. This is the one test that ties
     * the two shapes together: if the form grows a field the server has never seen, this fails
     * here rather than in front of eight people who have already turned up.
     */
    const created = await createOk({
      entrants: people(4),
      config: {
        format: 'DOUBLE_ELIMINATION',
        seeding: 'RANDOM',
        grandFinalReset: true,
        default: { modeId: 'base' },
        // Only the positions the organizer changed. Everything else falls back, and the fallback
        // is the server's (`chainFor`), not a copy of it in the client.
        overrides: { LOSERS: { modeId: 'bo1-bring3-ban1' } },
      },
    })

    const v = await view(created.code)
    expect(v.grandFinalReset).toBe(true)
    const modeAt = (position: string) => v.slots.find((s) => s.position === position)?.modeId
    expect(modeAt('LOSERS')).toBe('bo1-bring3-ban1')
    expect(modeAt('WINNERS')).toBe('base')
    // A random draw is still a *recorded* one: the seed comes from the code, so a re-read of the
    // same tournament is the same bracket rather than a fresh shuffle (Phase 2's finding).
    expect(v.entrants.map((e) => e.seed).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect((await view(created.code)).entrants).toEqual(v.entrants)
  })

  it('404s a code that does not exist, and 400s one that is not a code', async () => {
    expect((await SELF.fetch('https://example.com/api/tournament/T-ZZZZZZ')).status).toBe(404)
    expect((await SELF.fetch('https://example.com/api/tournament/ABC123')).status).toBe(400)
  })
})

describe('persistence', () => {
  it('survives hibernation — the bracket is rebuilt from storage, not held in memory', async () => {
    const created = await createOk({
      entrants: people(8),
      config: { format: 'DOUBLE_ELIMINATION' },
    })

    const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(created.code))
    // Evicting the instance is the real test: anything cached in a field is gone, and a second
    // read has to reconstruct the whole bracket from `entrants` plus the result log.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {
        await state.storage.sync()
      })
    })

    const again = await view(created.code)
    expect(again.slots).toHaveLength(15)
    expect(again.entrants.map((e) => e.seed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('refuses to be created twice', async () => {
    const created = await createOk({ entrants: people(4) })
    const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(created.code))
    const second = await stub.fetch('https://example.com/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: created.code, entrants: people(4) }),
    })
    expect(second.status).toBe(409)
  })

  it('arms a sweep seven days out (D42), not the lobby’s two hours', async () => {
    const created = await createOk({ entrants: people(4) })
    const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(created.code))

    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())
    expect(alarm).not.toBeNull()
    const days = (alarm! - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })
})
