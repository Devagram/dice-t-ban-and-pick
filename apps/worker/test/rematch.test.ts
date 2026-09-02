import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { playToCompletion, seatedMatch, TestClient } from './client.js'

/**
 * **D32 — play again.**
 *
 * The ruleset was already snapshotted into the creation event (§5), so a rematch is a copy of
 * something the match already knows rather than a form filled in again. Most of what matters here
 * is that it stays *one* room when both players ask for it, and that D28's no-repeat-ban answer
 * travels with it — a rematch is the case that rule was written for.
 *
 * **D53 adds the seats.** The room now comes back with both players already in it and each seat
 * holding its own token, so the assertions worth making are about who ends up where and about the
 * one value on this path that must never reach the wrong socket.
 */

const wsFor = (roomCode: string): string => `wss://example.com/api/match/${roomCode}/ws`

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
  it('creates a room carrying the same ruleset, with both seats already filled', async () => {
    const { a, roomCode } = await completed()

    const response = await rematch(a, roomCode)
    expect(response.status).toBe(201)
    const { roomCode: next } = (await response.json()) as { roomCode: string }
    expect(next).toMatch(/^[A-Z0-9]{6}$/)
    expect(next).not.toBe(roomCode)

    // The new room is real and describes itself the same way the old one did.
    const preview = await SELF.fetch(`https://example.com/api/match/${next}/preview`)
    expect(preview.status).toBe(200)
    const body = (await preview.json()) as {
      seatsAvailable: string[]
      ruleset: { modeId: string; parameters: Record<string, unknown> }
    }
    expect(body.ruleset.modeId).toBe('base')
    expect(body.ruleset.parameters).toMatchObject({ draftCount: 4 })
    /*
     * D53 — nothing is available, because the two people it is for are already in it. This is the
     * assertion that used to say the opposite: the room used to open empty and both players had
     * to re-take a seat under terms they had just played a whole match under.
     */
    expect(body.seatsAvailable).toEqual([])
  })

  it('hands the asking seat a token that opens its own seat, in the same letter', async () => {
    const { a, roomCode } = await completed()
    const before = a.seat

    const opened = (await (await rematch(a, roomCode)).json()) as {
      roomCode: string
      seatToken?: string
    }
    expect(opened.seatToken).toBeTruthy()

    // The token is the whole of "you do not have to rejoin": it has to actually open a socket.
    const resumed = await TestClient.resume(opened.seatToken!, wsFor(opened.roomCode))
    // Same letter as last set, which is what keeps a series a series — D28's carried ban and the
    // head-to-head both read the seat the player is sitting in.
    expect(resumed.seat).toBe(before)
    resumed.kill()
  })

  it('carries the seated identities across, rather than opening a room for strangers', async () => {
    const { a, roomCode } = await completed({ players: ['alice', 'bob'] })

    const opened = (await (await rematch(a, roomCode)).json()) as {
      roomCode: string
      seatToken?: string
    }
    const resumed = await TestClient.resume(opened.seatToken!, wsFor(opened.roomCode))
    const view = resumed.view

    // Seated by the server, so the names have to be the ones the finished match recorded and not
    // whatever a client would have retyped on a join page.
    expect(view.you.player?.id).toBe('alice')
    expect(view.opponent.player?.id).toBe('bob')
    resumed.kill()
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

  it('gives each of them their own seat in it, and never the other one', async () => {
    const { a, b, roomCode } = await completed()

    const [first, second] = await Promise.all([rematch(a, roomCode), rematch(b, roomCode)])
    const one = (await first.json()) as { roomCode: string; seatToken?: string }
    const two = (await second.json()) as { roomCode: string; seatToken?: string }

    expect(one.seatToken).toBeTruthy()
    expect(two.seatToken).toBeTruthy()
    /*
     * Two seats, two credentials. Handing both players the same token would put them in one seat
     * and leave the other empty — and it would hand each of them the other's hidden commits (§7),
     * which is the one thing a seat token must never be able to do.
     */
    expect(one.seatToken).not.toBe(two.seatToken)

    const [x, y] = await Promise.all([
      TestClient.resume(one.seatToken!, wsFor(one.roomCode)),
      TestClient.resume(two.seatToken!, wsFor(two.roomCode)),
    ])
    expect([x.seat, y.seat].sort()).toEqual(['A', 'B'])
    expect(x.seat).toBe(a.seat)
    expect(y.seat).toBe(b.seat)
    x.kill()
    y.kill()
  })

  it('tells the other seat over the socket they already share', async () => {
    const { a, b, roomCode } = await completed()
    const opened = (await (await rematch(a, roomCode)).json()) as {
      roomCode: string
      seatToken?: string
    }

    for (let i = 0; i < 60; i++) {
      if (b.rematches.length > 0) break
      await scheduler.wait(1)
    }
    // Without this the opponent has no way to learn the code, and "play again" is a link again.
    const announced = b.rematches.at(-1)
    expect(announced).toMatchObject({ type: 'REMATCH', roomCode: opened.roomCode, by: 'A' })

    /*
     * D53 — the frame carries B's seat, so B walks in rather than joining. And it carries **only**
     * B's: this is the one value on this wire that is not safe to fan out, so the frame that
     * reached B must not contain the token A was handed over HTTP.
     */
    expect(announced!.seatToken).toBeTruthy()
    expect(announced!.seatToken).not.toBe(opened.seatToken)
    expect(b.frames.join('\n')).not.toContain(opened.seatToken!)

    const resumed = await TestClient.resume(announced!.seatToken!, wsFor(opened.roomCode))
    expect(resumed.seat).toBe(b.seat)
    resumed.kill()
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
