import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch } from './client.js'
import type { TestClient } from './client.js'

/**
 * **D32 — play again.**
 *
 * The ruleset was already snapshotted into the creation event (§5), so a rematch is a copy of
 * something the match already knows rather than a form filled in again. Most of what matters here
 * is that it stays *one* room when both players ask for it, and that D28's no-repeat-ban answer
 * travels with it — a rematch is the case that rule was written for.
 */

async function rematch(client: TestClient, roomCode: string): Promise<Response> {
  return SELF.fetch(
    `https://example.com/api/match/${roomCode}/rematch?token=${encodeURIComponent(client.seatToken)}`,
    { method: 'POST' },
  )
}

async function completed(opts: Parameters<typeof seatedMatch>[0] = {}) {
  const match = await seatedMatch({ modeId: 'base', draftCount: 4, ...opts })
  await playToCompletion(match.a, match.b, ['A', 'B', 'A'])
  return match
}

describe('opening a rematch', () => {
  it('creates a joinable room carrying the same ruleset', async () => {
    const { a, roomCode } = await completed()

    const response = await rematch(a, roomCode)
    expect(response.status).toBe(201)
    const { roomCode: next } = (await response.json()) as { roomCode: string }
    expect(next).toMatch(/^[A-Z0-9]{6}$/)
    expect(next).not.toBe(roomCode)

    // The new room is real, open, and describes itself the same way the old one did.
    const preview = await SELF.fetch(`https://example.com/api/match/${next}/preview`)
    expect(preview.status).toBe(200)
    const body = (await preview.json()) as {
      seatsAvailable: string[]
      ruleset: { modeId: string; parameters: Record<string, unknown> }
    }
    expect(body.seatsAvailable).toEqual(['A', 'B'])
    expect(body.ruleset.modeId).toBe('base')
    expect(body.ruleset.parameters).toMatchObject({ draftCount: 4 })
  })

  it('carries the host answer on repeat bans, which is the rule a rematch is about', async () => {
    // D28's whole subject is "two sets in a row". A rematch that quietly dropped the setting
    // would disable the rule at the exact moment it was written to apply.
    const { a, roomCode } = await completed({ allowRepeatBans: false })
    const { roomCode: next } = (await (await rematch(a, roomCode)).json()) as { roomCode: string }

    const preview = (await (
      await SELF.fetch(`https://example.com/api/match/${next}/preview`)
    ).json()) as { ruleset: { constraints: { repeatBans: string } } }
    expect(preview.ruleset.constraints.repeatBans).toBe('FORBIDDEN')
  })

  it('gives both players the same room when they both ask', async () => {
    const { a, b, roomCode } = await completed()

    // The expected case, not an edge one: both people press the button.
    const [first, second] = await Promise.all([rematch(a, roomCode), rematch(b, roomCode)])
    const one = (await first.json()) as { roomCode: string }
    const two = (await second.json()) as { roomCode: string }

    expect(one.roomCode).toBe(two.roomCode)
    // And asking again later is still the same room, not a third one.
    const again = (await (await rematch(a, roomCode)).json()) as { roomCode: string }
    expect(again.roomCode).toBe(one.roomCode)
  })

  it('tells the other seat over the socket they already share', async () => {
    const { a, b, roomCode } = await completed()
    const { roomCode: next } = (await (await rematch(a, roomCode)).json()) as { roomCode: string }

    for (let i = 0; i < 60; i++) {
      if (b.rematches.length > 0) break
      await scheduler.wait(1)
    }
    // Without this the opponent has no way to learn the code, and "play again" is a link again.
    expect(b.rematches.at(-1)).toMatchObject({ type: 'REMATCH', roomCode: next, by: 'A' })
  })
})

describe('what a rematch refuses', () => {
  it('refuses without a seat token', async () => {
    const { roomCode } = await completed()
    const response = await SELF.fetch(`https://example.com/api/match/${roomCode}/rematch`, {
      method: 'POST',
    })
    expect(response.status).toBe(401)
  })

  it('refuses a token that is not for this match', async () => {
    const { roomCode } = await completed()
    const other = await completed()
    const response = await rematch(other.a, roomCode)
    expect(response.status).toBe(401)
  })

  it('refuses while the match is still going', async () => {
    const { a, roomCode } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    const response = await rematch(a, roomCode)
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe('NOT_COMPLETE')
  })
})
