import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { History } from '../src/screens/History.js'
import { Admin } from '../src/screens/Admin.js'

/**
 * **D44 — adding a game that was played away from the site.**
 *
 * The screen's job is narrower than it looks. It must not invent a player, must not offer to file
 * a match against nobody, and must send what the admin actually typed — including the *date*,
 * which is the only field here whose being wrong is invisible afterwards.
 *
 * The rest of these are about the one piece of arithmetic this form does: rounds drive the score
 * and the winner, because typing both is doing the same sum twice and disagreeing with yourself is
 * the likely outcome.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const PLAYERS = [
  {
    playerId: 'p_tom',
    name: 'Tom',
    claimedNames: ['Tom'],
    played: 4,
    wins: 3,
    losses: 1,
    draws: 0,
    firstPlayedAt: 1,
    lastPlayedAt: 2,
  },
  {
    playerId: 'p_alex',
    name: 'Alex',
    claimedNames: ['Alex'],
    played: 4,
    wins: 1,
    losses: 3,
    draws: 0,
    firstPlayedAt: 1,
    lastPlayedAt: 2,
  },
]

function serve(over: Record<string, { ok?: boolean; status?: number; body: unknown }> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const path = String(url)
    const override = over[path]
    if (override) {
      return Promise.resolve({
        ok: override.ok ?? true,
        status: override.status ?? (override.ok === false ? 409 : 200),
        json: () => Promise.resolve(override.body),
      } as Response)
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          path.includes('/api/admin/players')
            ? { players: PLAYERS }
            : path.includes('matchups')
              ? { matchups: [] }
              : path.includes('tournaments')
                ? { tournaments: [] }
                : path.includes('/api/admin/add')
                  ? { ok: true, match: { roomCode: 'M-QQQ111' } }
                  : { matches: [] },
        ),
    } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const call = (mock: { mock: { calls: unknown[][] } }, path: string) => {
  const found = mock.mock.calls.find((c) => String(c[0]) === path)
  if (!found) throw new Error(`no request to ${path}`)
  return found as [string, RequestInit]
}

const sent = (mock: ReturnType<typeof serve>) =>
  JSON.parse(String(call(mock, '/api/admin/add')[1].body)) as Record<string, unknown>

/** Enters a key and waits for the directory the form chooses players from. */
const keyed = async (fetchMock: ReturnType<typeof serve>) => {
  fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
  await screen.findByLabelText('Player in seat A')
  return fetchMock
}

const pick = (seat: 'A' | 'B', value: string) =>
  fireEvent.change(screen.getByLabelText(`Player in seat ${seat}`), { target: { value } })

const addButton = () => screen.getByRole('button', { name: 'Add match' })

describe('the add-a-match form', () => {
  it('needs the key, and says so rather than showing controls that cannot work', async () => {
    serve()
    render(<Admin onBack={() => {}} />)

    // Everything here is a write, and the directory it chooses players from is behind the key too.
    expect(await screen.findByText('Enter the admin key to add a match.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add match' })).toBeNull()
  })

  it('will not file a match until both seats name somebody', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    expect(addButton()).toHaveProperty('disabled', true)
    pick('A', 'p_tom')
    expect(addButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('choose or name both players')).toBeTruthy()

    pick('B', 'p_alex')
    expect(addButton()).toHaveProperty('disabled', false)
  })

  it('refuses a player against themselves before spending a round trip on it', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    pick('A', 'p_tom')
    pick('B', 'p_tom')
    expect(addButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('both seats are the same player')).toBeTruthy()
  })

  it('sends the chosen ids with the key in a header', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    pick('A', 'p_tom')
    pick('B', 'p_alex')
    fireEvent.click(addButton())

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    const [url, init] = call(fetchMock, '/api/admin/add')
    expect((init.headers as Record<string, string>)['x-admin-key']).toBe('sekrit')
    expect(String(url)).not.toContain('sekrit')
    // The name travels beside the id: it is what every other screen calls this player, and a
    // record captioned differently reads as somebody else.
    expect(sent(fetchMock)).toMatchObject({
      aId: 'p_tom',
      aName: 'Tom',
      bId: 'p_alex',
      bName: 'Alex',
    })
  })

  it('lets the rounds set the score and the winner', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')

    // A → B → Tie → unplayed, the same cycle the edit row uses.
    fireEvent.click(screen.getByLabelText('Round 1 of the match being added'))
    fireEvent.click(screen.getByLabelText('Round 2 of the match being added'))
    fireEvent.click(screen.getByLabelText('Round 2 of the match being added'))
    fireEvent.click(screen.getByLabelText('Round 3 of the match being added'))

    expect(screen.getByLabelText('Score for seat A')).toHaveProperty('value', '2')
    expect(screen.getByLabelText('Score for seat B')).toHaveProperty('value', '1')

    fireEvent.click(addButton())
    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    expect(sent(fetchMock)).toMatchObject({
      scoreA: 2,
      scoreB: 1,
      winnerId: 'A',
      rounds: ['A', 'B', 'A', null],
    })
  })

  it('counts a tie as half a point each, which is the only scoring rule there is', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')

    // D21: `HALF_POINT`, and a drawn match is a legal terminal state — so the winner has to land
    // on Draw rather than on whoever happens to be seat A.
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByLabelText('Round 1 of the match being added'))
    }
    expect(screen.getByLabelText('Score for seat A')).toHaveProperty('value', '0.5')

    fireEvent.click(addButton())
    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    expect(sent(fetchMock)).toMatchObject({ scoreA: 0.5, scoreB: 0.5, winnerId: null })
  })

  it('keeps a score typed by hand, for a game it cannot work out', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')

    fireEvent.change(screen.getByLabelText('Score for seat A'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Score for seat B'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tom' }))
    fireEvent.click(addButton())

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    const body = sent(fetchMock)
    expect(body).toMatchObject({ scoreA: 5, scoreB: 3, winnerId: 'A' })
    // Nothing was clicked in the rounds row, so there is no round-by-round to claim.
    expect(body['rounds']).toBeUndefined()
  })

  it('names somebody with no player id, and says what that costs', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    pick('A', 'p_tom')
    // The friend who has never opened the site. Without this the form is useless for exactly the
    // evenings it exists to record.
    expect(screen.queryByLabelText('Name for seat B')).toBeNull()
    pick('B', '—new—')
    fireEvent.change(screen.getByLabelText('Name for seat B'), { target: { value: 'Sam' } })
    expect(screen.getByText(/merge it into their real one/)).toBeTruthy()

    fireEvent.click(addButton())
    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    const body = sent(fetchMock)
    expect(body).toMatchObject({ aId: 'p_tom', bName: 'Sam' })
    // No id is sent for that seat: the server mints one, and a client-invented id would be an id
    // no browser will ever hold.
    expect(body['bId']).toBeUndefined()
  })

  it('sends the date it was played rather than the date it was typed', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')

    fireEvent.change(screen.getByLabelText('Date it was played'), {
      target: { value: '2026-03-14' },
    })
    fireEvent.click(addButton())

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    /*
     * Midday local, not midnight UTC. `Date.parse('2026-03-14')` is UTC, so west of Greenwich the
     * game would be filed on the 13th — which is the one thing the field exists to get right, and
     * invisible once it is stored.
     */
    const at = new Date(Number(sent(fetchMock)['playedAt']))
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 2, 14])
  })

  it('clears itself after filing one, so the next add is not a copy of the last', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')
    fireEvent.click(screen.getByLabelText('Round 1 of the match being added'))
    fireEvent.click(addButton())

    expect(await screen.findByText('Match added.')).toBeTruthy()
    await waitFor(() => expect(addButton()).toHaveProperty('disabled', true))
    expect(screen.getByLabelText('Score for seat A')).toHaveProperty('value', '0')
  })

  it('relays a refusal in the server’s words', async () => {
    const fetchMock = serve({
      '/api/admin/add': {
        ok: false,
        status: 409,
        body: { error: 'SELF_MATCH', detail: 'both seats are the same player' },
      },
    })
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)
    pick('A', 'p_tom')
    pick('B', 'p_alex')
    fireEvent.click(addButton())

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('both seats are the same player')
  })
})

describe('a match added by hand, on the history page', () => {
  const record = (roomCode: string) => ({
    roomCode,
    playedAt: Date.now(),
    a: { id: 'p_tom', name: 'Tom' },
    b: { id: 'p_alex', name: 'Alex' },
    winnerId: 'p_tom',
    scoreA: 2,
    scoreB: 1,
    detail: { rounds: ['A', 'B', 'A'] },
  })

  it('says so, rather than passing as a game both seats reported', async () => {
    serve({ '/api/matches': { body: { matches: [record('M-QQQ111')] } } })
    render(<History onBack={() => {}} />)

    // It counts like any other match, which is why this is a caption and not an asterisk — but a
    // row nobody's client ever reported is a weaker claim, and the page should not hide which.
    expect(await screen.findByText('added by hand')).toBeTruthy()
  })

  it('leaves a played match unmarked', async () => {
    serve({ '/api/matches': { body: { matches: [record('ABC123')] } } })
    render(<History onBack={() => {}} />)

    await screen.findByText('2–1')
    expect(screen.queryByText('added by hand')).toBeNull()
  })

  it('renders one with no rosters behind it', async () => {
    // Nobody drafted anything, so `detail.seats` is absent — which the page has always guarded
    // for and never actually been handed until now.
    serve({ '/api/matches': { body: { matches: [record('M-QQQ111')] } } })
    render(<History onBack={() => {}} />)

    expect(await screen.findByText('Tom won')).toBeTruthy()
    expect(screen.getAllByText('Tom').length).toBeGreaterThan(0)
  })
})
