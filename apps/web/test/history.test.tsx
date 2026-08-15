import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Admin } from '../src/screens/Admin.js'
import { History } from '../src/screens/History.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const MATCH = {
  roomCode: 'ABC123',
  playedAt: Date.now() - 86400000,
  a: { id: 'p-a', name: 'Tom' },
  b: { id: 'p-b', name: 'Alex' },
  winnerId: 'p-a',
  scoreA: 2,
  scoreB: 1,
  detail: {
    // Four entries: three regulation rounds plus D30's overtime, unplayed here.
    rounds: ['A', 'B', 'A', null],
    seats: {
      A: {
        drafted: ['barbarian', 'moon-elf', 'pyromancer', 'gunslinger'],
        played: ['barbarian', 'moon-elf', 'pyromancer'],
        metaBan: 'seraph',
      },
      B: {
        drafted: ['ninja', 'paladin', 'huntress', 'artificer'],
        played: ['ninja', 'paladin', 'huntress'],
        metaBan: null,
      },
    },
  },
}

const MATCHUP = {
  a: { id: 'p-a', name: 'Tom' },
  b: { id: 'p-b', name: 'Alex' },
  aWins: 3,
  bWins: 2,
  draws: 1,
  played: 6,
}

function serve(over: { matches?: unknown[]; matchups?: unknown[] } = {}) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          String(url).includes('matchups')
            ? { matchups: over.matchups ?? [MATCHUP] }
            : { matches: over.matches ?? [MATCH] },
        ),
    } as Response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('the history page', () => {
  it('shows the Bo3 round by round, naming who took each', async () => {
    serve()
    render(<History onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('2–1')).toBeTruthy())
    // Named, not "A" and "B" — a seat letter means nothing a week later.
    expect(screen.getAllByText('Tom').length).toBeGreaterThan(0)
    expect(screen.getByText('R1')).toBeTruthy()
    expect(screen.getByText('R3')).toBeTruthy()
    // Index 3 is D30's overtime round, and it is not the fourth round of anything.
    expect(screen.getByText('OT')).toBeTruthy()
  })

  it('marks a round nobody played as a real state rather than missing data', async () => {
    serve()
    const { container } = render(<History onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('OT')).toBeTruthy())
    // `stopWhenDecided` skipping a dead rubber is information, not an absence.
    expect(container.querySelectorAll('.hround--unplayed')).toHaveLength(1)
    expect(container.querySelectorAll('.hround--played')).toHaveLength(3)
  })

  it('shows both rosters, distinguishing what was played from what was benched', async () => {
    serve()
    const { container } = render(<History onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('Barbarian')).toBeTruthy())
    // Four drafted each, three played each: the benched one is the interesting half.
    expect(container.querySelectorAll('.hchar--played')).toHaveLength(6)
    expect(container.querySelectorAll('.hchar--bench')).toHaveLength(2)
    expect(screen.getByText('Gunslinger')).toBeTruthy()
    expect(screen.getByText('banned Seraph')).toBeTruthy()
  })

  it('shows the pairwise record', async () => {
    serve()
    render(<History onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('Tom vs Alex')).toBeTruthy())
    expect(screen.getByText('3–2 (1D)')).toBeTruthy()
    expect(screen.getByText('6 matches')).toBeTruthy()
  })

  it('says it is empty rather than looking broken', async () => {
    serve({ matches: [], matchups: [] })
    render(<History onBack={() => {}} />)

    expect(await screen.findByText('Nothing has been played yet.')).toBeTruthy()
    // And the matchups section is absent entirely rather than an empty heading.
    expect(screen.queryByText('Matchups')).toBeNull()
  })
})

/**
 * A save reloads the list, so the admin request is never the *last* call. Looking it up by path
 * rather than by position is what stops these tests from asserting on the reload.
 */
const adminCall = (mock: { mock: { calls: unknown[][] } }, path: string) => {
  const call = mock.mock.calls.find((c) => String(c[0]) === path)
  if (!call) throw new Error(`no request to ${path}`)
  return call as [string, RequestInit]
}

describe('the admin dashboard', () => {
  it('will not let you edit without a key', async () => {
    serve()
    render(<Admin onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Enter the admin key to edit.')).toBeTruthy()
  })

  it('sends the key in a header, not the URL', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    const [url, init] = adminCall(fetchMock, '/api/admin/edit')
    // In a header so it stays out of browser history and out of anything that logs paths.
    expect((init.headers as Record<string, string>)['x-admin-key']).toBe('sekrit')
    expect(String(url)).not.toContain('sekrit')
  })

  it('sends a draw as null rather than a seat', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'k' } })

    fireEvent.click(screen.getByRole('button', { name: 'Draw' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1))
    const body = JSON.parse(String(adminCall(fetchMock, '/api/admin/edit')[1].body))
    expect(body.winnerId).toBeNull()
  })

  it('cycles a round through every state it can hold', async () => {
    serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())

    const round = screen.getByRole('button', { name: /^R1:/ })
    expect(round.textContent).toContain('A')
    fireEvent.click(round)
    expect(round.textContent).toContain('B')
    fireEvent.click(round)
    expect(round.textContent).toContain('Tie')
    // Unplayed is a state a round can genuinely be in, so the cycle has to reach it.
    fireEvent.click(round)
    expect(round.textContent).toContain('—')
  })

  it('asks twice before deleting, because nothing undoes it', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'k' } })

    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    // The first click only arms it — the record is all that survives an expired room.
    expect(fetchMock.mock.calls.length).toBe(callsBefore)

    const row = screen.getByText('ABC123').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: 'Really delete' }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore))
    expect(JSON.parse(String(adminCall(fetchMock, '/api/admin/delete')[1].body))).toEqual({
      roomCode: 'ABC123',
    })
  })

  it('explains a refused edit rather than failing silently', async () => {
    serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'wrong' } })

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('401'))),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Check the admin key/)).toBeTruthy()
  })
})
