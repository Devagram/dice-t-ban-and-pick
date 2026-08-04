import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { createMatch, playToCompletion, seatedMatch, TestClient } from './client.js'

/**
 * **D31 — the open-room list.**
 *
 * The room code stopped being the only way to find a game. Everything here is about the listing
 * tracking the room's actual state, because a lobby that lists rooms you cannot join is worse
 * than no lobby: every stale entry is a click that goes nowhere.
 */

async function lobbies(): Promise<
  { roomCode: string; status: string; seatsTaken: number; hostName: string; modeLabel: string }[]
> {
  const response = await SELF.fetch('https://example.com/api/lobbies')
  expect(response.ok).toBe(true)
  return ((await response.json()) as { rooms: never[] }).rooms
}

/** The registry writes ride on `waitUntil`, so the list settles a beat after the action. */
async function lobbyFor(roomCode: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const found = (await lobbies()).find((r) => r.roomCode === roomCode)
    if (found) return found
    await scheduler.wait(1)
  }
  throw new Error(`room ${roomCode} never reached the lobby list`)
}

async function goneFrom(roomCode: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (!(await lobbies()).some((r) => r.roomCode === roomCode)) return
    await scheduler.wait(1)
  }
  throw new Error(`room ${roomCode} never left the lobby list`)
}

describe('a room appears and updates as it fills', () => {
  it('is listed as OPEN the moment it is created, before anyone sits', async () => {
    const { roomCode } = await createMatch({ modeId: 'base', draftCount: 4 })
    const room = await lobbyFor(roomCode)

    expect(room.status).toBe('OPEN')
    expect(room.seatsTaken).toBe(0)
    // A room predates its players (the same fact D28's pairing resolution turns on), so there is
    // no host name to show yet.
    expect(room.hostName).toBe('')
    expect(room.modeLabel).toContain('Bo3')
  })

  it('takes the host name from whoever sits in seat A', async () => {
    const { roomCode } = await createMatch({ modeId: 'base', draftCount: 4 })
    await TestClient.claimSeat(roomCode, { playerId: 'lob-a', displayName: 'Tom' })

    const room = await lobbyFor(roomCode)
    expect(room).toMatchObject({ status: 'OPEN', seatsTaken: 1, hostName: 'Tom' })
  })

  it('turns to PLAYING when both seats are taken, and stays listed', async () => {
    const { roomCode } = await createMatch({ modeId: 'base', draftCount: 4 })
    await TestClient.claimSeat(roomCode, { playerId: 'lob-h', displayName: 'Host' })
    await TestClient.claimSeat(roomCode, { playerId: 'lob-j', displayName: 'Joiner' })

    // Listed rather than dropped: a full game is still worth finding, because it can be watched.
    for (let i = 0; i < 60; i++) {
      const room = await lobbyFor(roomCode)
      if (room.status === 'PLAYING') {
        expect(room.seatsTaken).toBe(2)
        expect(room.hostName).toBe('Host')
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('the room never turned to PLAYING')
  })

  it('does not let the joiner overwrite the host name', async () => {
    const { roomCode } = await createMatch({ modeId: 'base', draftCount: 4 })
    await TestClient.claimSeat(roomCode, { playerId: 'lob-h2', displayName: 'Host' })
    await TestClient.claimSeat(roomCode, { playerId: 'lob-j2', displayName: 'Joiner' })
    await scheduler.wait(20)

    expect((await lobbyFor(roomCode)).hostName).toBe('Host')
  })
})

describe('a room leaves the list when it is over', () => {
  it('is delisted once the match completes', async () => {
    const { a, b, roomCode } = await seatedMatch({ modeId: 'base', draftCount: 4 })
    await lobbyFor(roomCode)

    await playToCompletion(a, b, ['A', 'B', 'A'])
    await goneFrom(roomCode)
  })
})

describe('the list itself', () => {
  it('shows several rooms, open ones first', async () => {
    const open = await createMatch({ modeId: 'base', draftCount: 4 })
    const full = await createMatch({ modeId: 'base', draftCount: 4 })
    await TestClient.claimSeat(full.roomCode, { playerId: 'ord-1', displayName: 'One' })
    await TestClient.claimSeat(full.roomCode, { playerId: 'ord-2', displayName: 'Two' })
    await lobbyFor(open.roomCode)

    for (let i = 0; i < 60; i++) {
      const list = await lobbies()
      const openAt = list.findIndex((r) => r.roomCode === open.roomCode)
      const fullAt = list.findIndex((r) => r.roomCode === full.roomCode)
      // A game you can join is the thing the list is for; one you can only watch sorts below it.
      if (openAt >= 0 && fullAt >= 0 && list[fullAt]!.status === 'PLAYING') {
        expect(openAt).toBeLessThan(fullAt)
        return
      }
      await scheduler.wait(1)
    }
    throw new Error('both rooms never appeared with settled statuses')
  })
})
