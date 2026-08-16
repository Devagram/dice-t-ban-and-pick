import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Lobbies } from '../src/screens/Lobbies.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const room = (over: Partial<Record<string, unknown>> = {}) => ({
  roomCode: 'ABC123',
  modeLabel: 'Standard Bo3 — draft 4',
  hostName: 'Tom',
  seatsTaken: 1,
  status: 'OPEN',
  openedAt: Date.now() - 4 * 60000,
  ...over,
})

function serve(rooms: unknown[]) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ rooms }) } as Response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('the lobby list', () => {
  it('offers a seat on an open room and no link at all on a full one', async () => {
    serve([
      room({ roomCode: 'OPEN01', hostName: 'Tom', status: 'OPEN', seatsTaken: 1 }),
      room({ roomCode: 'FULL01', hostName: 'Alex', status: 'PLAYING', seatsTaken: 2 }),
    ])
    render(<Lobbies onBack={() => {}} />)

    const take = await screen.findByRole('link', { name: 'Take the seat' })
    expect(take.getAttribute('href')).toBe('/j/OPEN01')

    /*
     * A full room stays listed so you can see a game is happening, but offers no link: its join
     * page says "Both seats taken" and nothing else, so a link there would be a dead end wearing
     * an inviting label. Becomes a real "Watch" when spectating lands.
     */
    expect(screen.getByText('Under way')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Watch' })).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Take the seat' })).toHaveLength(1)
    expect(screen.queryAllByRole('link').map((l) => l.getAttribute('href'))).not.toContain(
      '/j/FULL01',
    )
  })

  it('separates waiting rooms from ones already under way', async () => {
    serve([room({ roomCode: 'A00001' }), room({ roomCode: 'B00001', status: 'PLAYING' })])
    render(<Lobbies onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('In progress')).toBeTruthy())
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    // Joinable first: it is what someone opening this screen came to do. The code field is last
    // for the same reason — a code you were *sent* is a link, so typing one is the rarer path.
    expect(headings).toEqual(['Waiting for a player', 'In progress', 'Have a code?'])
  })

  it('says a room has no host yet rather than showing a blank', async () => {
    // A room exists before anyone sits down, which is the same fact D28's pairing turns on.
    serve([room({ hostName: '' })])
    render(<Lobbies onBack={() => {}} />)

    expect(await screen.findByText('Nobody yet')).toBeTruthy()
  })

  it('tells you the list is empty rather than looking broken', async () => {
    serve([])
    render(<Lobbies onBack={() => {}} />)

    expect(await screen.findByText(/Nobody is waiting right now/)).toBeTruthy()
    // And the in-progress section is absent entirely rather than an empty heading.
    expect(screen.queryByText('In progress')).toBeNull()
  })

  it('keeps showing the last list when a refresh fails', async () => {
    const good = { ok: true, json: () => Promise.resolve({ rooms: [room({ hostName: 'Tom' })] }) }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(good as Response)
      .mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<Lobbies onBack={() => {}} />)
    expect(await screen.findByText('Tom')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(6000)
    // A dropped poll is not worth replacing a working screen with an error.
    expect(screen.getByText('Tom')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a failure when there was never anything to show', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    )
    render(<Lobbies onBack={() => {}} />)

    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('polling', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  it('refreshes on an interval and stops when the screen goes away', async () => {
    const fetchMock = serve([room()])
    const { unmount } = render(<Lobbies onBack={() => {}} />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(11000)
    const whileMounted = fetchMock.mock.calls.length
    expect(whileMounted).toBeGreaterThan(1)

    // A timer that outlives the screen keeps hitting the worker forever.
    unmount()
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchMock.mock.calls.length).toBe(whileMounted)
  })
})
