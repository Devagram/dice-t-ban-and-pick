import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Admin } from '../src/screens/Admin.js'

/**
 * **D46 — choosing the heroes, on both admin forms.**
 *
 * D44 left the rosters read-only on the reasoning that a wrong score is a typo and a wrong roster
 * is a different game. D45's hero board is what changed that: an unattributed round is now a
 * missing row on a public table, and for a match whose Durable Object expired months ago this
 * screen is the only place it can ever be fixed.
 *
 * The control's whole job is to make an id impossible to mistype and to send what it is showing.
 * Everything else about a lineup is the server's call, including refusing an id it does not know.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** The roster the screen picks from. Trimmed — the real one is forty-four. */
const ROSTER = {
  rosterVersion: '2026.08.28-1',
  characters: [
    { id: 'thor', name: 'Thor', blurb: '', status: 'ACTIVE' },
    { id: 'loki', name: 'Loki', blurb: '', status: 'ACTIVE' },
    { id: 'ninja', name: 'Ninja', blurb: '', status: 'ACTIVE' },
  ],
}

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

/** A stored match with a D45 lineup on it — three rounds played, the fourth never reached. */
const MATCH = {
  roomCode: 'ABC123',
  playedAt: Date.now() - 86400000,
  a: { id: 'p_tom', name: 'Tom' },
  b: { id: 'p_alex', name: 'Alex' },
  winnerId: 'p_tom',
  scoreA: 2,
  scoreB: 1,
  detail: {
    rounds: ['A', 'B', 'A', null],
    seats: {
      A: {
        drafted: ['thor', 'loki'],
        played: ['thor', 'loki'],
        metaBan: null,
        lineup: ['thor', 'loki', 'thor', null],
      },
      B: {
        drafted: ['ninja'],
        played: ['ninja'],
        metaBan: null,
        lineup: ['ninja', 'ninja', 'ninja', null],
      },
    },
  },
}

function serve(over: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const path = String(url)
    const key = Object.keys(over).find((k) => path.includes(k))
    const body =
      key !== undefined
        ? over[key]
        : path.includes('/api/roster')
          ? ROSTER
          : path.includes('/api/admin/players')
            ? { players: PLAYERS }
            : path.includes('matchups')
              ? { matchups: [] }
              : path.includes('/api/admin/')
                ? { ok: true, match: MATCH }
                : { matches: [MATCH] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const call = (mock: { mock: { calls: unknown[][] } }, path: string) => {
  const found = mock.mock.calls.find((c) => String(c[0]) === path)
  if (!found) throw new Error(`no request to ${path}`)
  return found as [string, RequestInit]
}

const sent = (mock: ReturnType<typeof serve>, path: string) =>
  JSON.parse(String(call(mock, path)[1].body)) as Record<string, unknown>

/** Enters the key and waits for the add form, which only appears once the server accepts it. */
const keyed = async (fetchMock: ReturnType<typeof serve>) => {
  fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
  await screen.findByLabelText('Player in seat A')
  return fetchMock
}

describe('naming the heroes on a match being added', () => {
  it('offers them as a menu of names', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    const pick = screen.getByLabelText('Hero for seat A in round 1 of the match being added')
    // Names, not ids: nobody should have to know `moon-elf` has a hyphen in it, and the server
    // refuses anything off the roster anyway.
    expect(within(pick).getByText('Thor')).toBeTruthy()
    // A round nobody has named a hero for is a real state, so the empty option stays.
    expect(within(pick).getByText('—')).toBeTruthy()
  })

  it('sends the chosen heroes, indexed against the rounds', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Player in seat A'), { target: { value: 'p_tom' } })
    fireEvent.change(screen.getByLabelText('Player in seat B'), { target: { value: 'p_alex' } })
    fireEvent.click(screen.getByLabelText('Round 1 of the match being added'))
    fireEvent.change(screen.getByLabelText('Hero for seat A in round 1 of the match being added'), {
      target: { value: 'thor' },
    })
    fireEvent.change(screen.getByLabelText('Hero for seat B in round 1 of the match being added'), {
      target: { value: 'ninja' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    // Position two is round three whatever happened in round two, which is the contract the
    // aggregation reads a lineup under.
    expect(sent(fetchMock, '/api/admin/add')['aLineup']).toEqual(['thor', null, null, null])
    expect(sent(fetchMock, '/api/admin/add')['bLineup']).toEqual(['ninja', null, null, null])
  })

  it('leaves the lineup out entirely when no hero was named', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Player in seat A'), { target: { value: 'p_tom' } })
    fireEvent.change(screen.getByLabelText('Player in seat B'), { target: { value: 'p_alex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/add')).not.toThrow())
    const body = sent(fetchMock, '/api/admin/add')
    // Stored exactly as D44 stored it: a result, and no claim about who played it.
    expect(body['aLineup']).toBeUndefined()
    expect(body['bLineup']).toBeUndefined()
  })

  it('clears the heroes with the rest of the form after filing one', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Player in seat A'), { target: { value: 'p_tom' } })
    fireEvent.change(screen.getByLabelText('Player in seat B'), { target: { value: 'p_alex' } })
    fireEvent.change(screen.getByLabelText('Hero for seat A in round 1 of the match being added'), {
      target: { value: 'thor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    // The next add is a new game, not a copy of the last one — a hero left in the form is a hero
    // credited with a round it never played.
    await waitFor(() =>
      expect(
        screen.getByLabelText('Hero for seat A in round 1 of the match being added'),
      ).toHaveProperty('value', ''),
    )
  })
})

describe('correcting the heroes on a stored match', () => {
  it('seeds each round from what the record already says', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    // Shown rather than blank, so an admin fixing round three does not have to retype rounds one
    // and two from memory — and can see at a glance which rounds have nobody on them.
    expect(screen.getByLabelText('Hero for seat A in round 2 in ABC123')).toHaveProperty(
      'value',
      'loki',
    )
    expect(screen.getByLabelText('Hero for seat A in round 4 in ABC123')).toHaveProperty(
      'value',
      '',
    )
  })

  it('sends both seats whole when saving', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Hero for seat A in round 2 in ABC123'), {
      target: { value: 'thor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/edit')).not.toThrow())
    const body = sent(fetchMock, '/api/admin/edit')
    // Whole, not a patch: half a lineup is indistinguishable from a round meant to be cleared.
    expect(body['aLineup']).toEqual(['thor', 'thor', 'thor', null])
    expect(body['bLineup']).toEqual(['ninja', 'ninja', 'ninja', null])
  })

  it('can attribute a record that never had heroes on it', async () => {
    // What a D44 hand-added match looks like: rounds, no seats. This screen is the only place its
    // rounds can ever reach the hero board — the match's own log expired months ago.
    const bare = { ...MATCH, roomCode: 'M-QQQ111', detail: { rounds: ['A', 'B'] } }
    const fetchMock = serve({ '/api/matches': { matches: [bare] } })
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Hero for seat A in round 1 in M-QQQ111'), {
      target: { value: 'thor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/edit')).not.toThrow())
    expect(sent(fetchMock, '/api/admin/edit')['aLineup']).toEqual(['thor', null])
  })

  it('keeps a hero the roster has forgotten selectable on a row that holds it', async () => {
    // D14 retires rather than deletes, so this is rare — but a row that silently dropped one on
    // the next Save would rewrite history to say a character was never played.
    const retired = {
      ...MATCH,
      detail: {
        ...MATCH.detail,
        seats: {
          A: { ...MATCH.detail.seats.A, lineup: ['deadpool', null, null, null] },
          B: MATCH.detail.seats.B,
        },
      },
    }
    const fetchMock = serve({ '/api/matches': { matches: [retired] } })
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    const pick = screen.getByLabelText('Hero for seat A in round 1 in ABC123')
    expect(pick).toHaveProperty('value', 'deadpool')
    expect(within(pick).getByText('deadpool')).toBeTruthy()
  })

  it('does not offer a menu it has no heroes to put in', async () => {
    /*
     * The roster is public and needs no key, but a deployment that cannot serve it should lose the
     * control rather than show an empty one — the list *is* the control, and an empty menu is not
     * a degraded version of it.
     */
    const fetchMock = serve({ '/api/roster': { rosterVersion: 'x', characters: [] } })
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    expect(screen.queryByLabelText('Hero for seat A in round 1 in ABC123')).toBeNull()
    // The rest of the row still edits, which is the point of failing soft here.
    expect(screen.getByLabelText('Name for seat A in ABC123')).toBeTruthy()
  })
})
