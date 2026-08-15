import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Admin } from '../src/screens/Admin.js'

/**
 * **D35 — player ids on the dashboard, and consolidating two of them.**
 *
 * The screen's job here is narrow and worth stating: it must show an id in full, never invent
 * one, and never perform a merge in one click. Everything else about a merge is the server's
 * decision, including refusing it — so these also cover the dashboard *relaying* that refusal
 * instead of flattening it into "something went wrong", which is the only way the admin learns
 * which matches are in the way.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const MATCH = {
  roomCode: 'ABC123',
  playedAt: Date.now() - 86400000,
  a: { id: 'p_old-laptop', name: 'Tom' },
  b: { id: 'p_alex', name: 'Alex' },
  winnerId: 'p_old-laptop',
  scoreA: 2,
  scoreB: 1,
  detail: {
    rounds: ['A', 'B', 'A', null],
    seats: {
      A: { drafted: ['barbarian', 'moon-elf'], played: ['barbarian'], metaBan: 'seraph' },
      B: { drafted: ['ninja', 'paladin'], played: ['ninja'], metaBan: null },
    },
  },
}

const PLAYERS = [
  {
    playerId: 'p_old-laptop',
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
    playerId: 'p_new-phone',
    name: 'Tom (phone)',
    claimedNames: ['Tom (phone)'],
    played: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    firstPlayedAt: 0,
    lastPlayedAt: 0,
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

/** `over` replaces the response for one path — the rest keep answering normally. */
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
              : path.includes('/api/admin/merge')
                ? { ok: true, moved: 4, names: 1, players: PLAYERS }
                : { matches: [MATCH] },
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

/*
 * Waits on the merge control rather than on an id, and the difference matters: the ids also
 * appear on the match rows, which render before the directory has loaded — so waiting for one
 * would return while the panel this helper exists to populate is still empty.
 */
const keyed = async (fetchMock: ReturnType<typeof serve>) => {
  fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
  await screen.findByLabelText('Merge this player')
  return fetchMock
}

/**
 * The key field has no submit button and never did — the key is a header on each edit, not a
 * login. That is defensible; giving no answer at all to "did that work?" was not, and these are
 * the four answers it now has.
 */
describe('entering the admin key', () => {
  it('confirms a key that works', async () => {
    serve()
    render(<Admin onBack={() => {}} />)
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })

    expect(await screen.findByText('Key accepted.')).toBeTruthy()
    // And it says so instead of leaving the reader hunting for a button that is not there.
    expect(screen.getByText(/nothing to submit/)).toBeTruthy()
  })

  it('distinguishes a deployment with no key from a key that is wrong', async () => {
    // `503 ADMIN_DISABLED` is the state of a Worker that never had `wrangler secret put` run
    // against it — including every local `wrangler dev`, which reads `.dev.vars` instead. Calling
    // that "wrong key" sends someone to check the one thing that is not the problem.
    serve({
      '/api/admin/players': {
        ok: false,
        status: 503,
        body: { error: 'ADMIN_DISABLED', detail: 'no ADMIN_KEY is configured' },
      },
    })
    render(<Admin onBack={() => {}} />)
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })

    expect(await screen.findByText(/no admin key set/i)).toBeTruthy()
    expect(screen.getByText(/\.dev\.vars/)).toBeTruthy()
  })

  it('says plainly when the server refuses the key', async () => {
    serve({
      '/api/admin/players': { ok: false, status: 401, body: { error: 'UNAUTHORIZED' } },
    })
    render(<Admin onBack={() => {}} />)
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'wrong' } })

    expect(await screen.findByText('The server refused that key.')).toBeTruthy()
  })

  it('survives a browser that refuses localStorage', () => {
    /*
     * `player.ts` wraps every storage access for exactly this case and says why. This screen did
     * not, so a browser with storage blocked threw during the first render — and a screen that is
     * blank is indistinguishable from one that will not accept a key.
     */
    const blocked = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    vi.stubGlobal('localStorage', blocked)
    serve()

    render(<Admin onBack={() => {}} />)
    expect(screen.getByLabelText('Admin key')).toBeTruthy()
    // And it still takes a key — it just will not remember it next time.
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
    expect(screen.getByLabelText('Admin key')).toHaveProperty('value', 'sekrit')
  })
})

describe('the player directory', () => {
  it('says what it needs rather than showing an empty list without a key', async () => {
    serve()
    render(<Admin onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    // The list is admin-only on the server, so with no key there is nothing to show and the
    // screen should say which of the two that is.
    expect(screen.getByText('Enter the admin key to list players.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull()
    /*
     * The ids on the *match rows* are still shown, and deliberately: they come from
     * `/api/matches`, which is public, so hiding them here would be a padlock on an open door
     * while costing the one thing this screen is for. `p_new-phone` has never played, so it
     * exists only in the directory — and that is what the key is actually gating.
     */
    expect(screen.getByText('p_old-laptop')).toBeTruthy()
    expect(screen.queryByText('p_new-phone')).toBeNull()
  })

  it('fetches with the key in a header and shows every id in full', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABC123')).toBeTruthy())
    await keyed(fetchMock)

    const [url, init] = call(fetchMock, '/api/admin/players')
    expect((init.headers as Record<string, string>)['x-admin-key']).toBe('sekrit')
    expect(String(url)).not.toContain('sekrit')

    // In full: a shortened id cannot be compared by eye or pasted, which is all anyone does here.
    expect(screen.getByText('p_new-phone')).toBeTruthy()
    expect(screen.getByText('3–1')).toBeTruthy()
  })

  it('marks the id that has claimed a name but never played', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    // This is what a returning player's second browser looks like, and it is the row an admin
    // came to merge — so it is called out rather than shown as a zero among zeroes.
    expect(screen.getByText('claimed a name, never finished a match')).toBeTruthy()
  })
})

describe('consolidating two ids', () => {
  const armMerge = async (fetchMock: ReturnType<typeof serve>) => {
    await keyed(fetchMock)
    fireEvent.change(screen.getByLabelText('Merge this player'), {
      target: { value: 'p_new-phone' },
    })
    fireEvent.change(screen.getByLabelText('Into this one'), { target: { value: 'p_old-laptop' } })
  }

  it('asks twice, because a merge cannot be undone by merging back', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await armMerge(fetchMock)

    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(fetchMock.mock.calls.length).toBe(before)

    fireEvent.click(screen.getByRole('button', { name: /^Move 0 matches to Tom$/ }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before))
    expect(JSON.parse(String(call(fetchMock, '/api/admin/merge')[1].body))).toMatchObject({
      fromId: 'p_new-phone',
      intoId: 'p_old-laptop',
    })
  })

  it('offers the surviving id’s name as the name to keep', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await armMerge(fetchMock)

    // Pre-filled from the target, so captioning the merged history is opt-out rather than a step
    // you discover you needed once the leaderboard reads "Tom (phone)".
    expect(screen.getByLabelText('Name them')).toHaveProperty('value', 'Tom')

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(3))
    expect(JSON.parse(String(call(fetchMock, '/api/admin/merge')[1].body)).name).toBe('Tom')
  })

  it('cannot be armed for an id against itself', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    for (const label of ['Merge this player', 'Into this one']) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: 'p_alex' } })
    }
    expect(screen.getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true)
  })

  it('does not leave a merged-away id sitting in a match row, ready to be saved back', async () => {
    // The row seeds its fields from the record once. A merge rewrites those ids underneath it,
    // and a row that kept the old one would undo the merge for that match on the next Save —
    // silently, since the field would still look correct.
    let merged = false
    const fetchMock = vi.fn((url: string) => {
      const path = String(url)
      if (path === '/api/admin/merge') merged = true
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            path.includes('/api/admin/players')
              ? { players: PLAYERS }
              : path.includes('matchups')
                ? { matchups: [] }
                : path === '/api/admin/merge'
                  ? { ok: true, moved: 4, names: 1, players: PLAYERS }
                  : {
                      matches: [
                        merged ? { ...MATCH, a: { id: 'p_new-phone', name: 'Tom' } } : MATCH,
                      ],
                    },
          ),
      } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock as unknown as ReturnType<typeof serve>)
    fireEvent.change(screen.getByLabelText('Merge this player'), {
      target: { value: 'p_old-laptop' },
    })
    fireEvent.change(screen.getByLabelText('Into this one'), { target: { value: 'p_new-phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }))

    await waitFor(() =>
      expect(screen.getByLabelText('Player in seat A of ABC123')).toHaveProperty(
        'value',
        'p_new-phone',
      ),
    )
  })

  it('relays a refusal in the server’s words, naming the matches in the way', async () => {
    const fetchMock = serve({
      '/api/admin/merge': {
        ok: false,
        body: {
          error: 'SELF_MATCH',
          roomCodes: ['ABC123'],
          detail: 'these two ids played each other in ABC123 — delete or reassign those first',
        },
      },
    })
    render(<Admin onBack={() => {}} />)
    await armMerge(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }))

    // "That did not go through" would be a dead end: the fix needs the room codes, and only the
    // server knows them.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ABC123')
    expect(alert.textContent).toContain('delete or reassign')
  })
})

describe('reassigning one match', () => {
  it('sends the chosen id for the seat', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Player in seat A of ABC123'), {
      target: { value: 'p_new-phone' },
    })
    // Shown because a reassignment is easy to make by accident and impossible to see afterwards.
    expect(screen.getByText('was p_old-laptop')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(() => call(fetchMock, '/api/admin/edit')).not.toThrow())
    const body = JSON.parse(String(call(fetchMock, '/api/admin/edit')[1].body))
    expect(body).toMatchObject({ roomCode: 'ABC123', aId: 'p_new-phone', bId: 'p_alex' })
  })

  it('offers ids rather than a text field, and keeps one the directory has forgotten', async () => {
    serve({ '/api/admin/players': { body: { players: [PLAYERS[1], PLAYERS[2]] } } })
    render(<Admin onBack={() => {}} />)
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
    await waitFor(() => expect(screen.getByText('p_new-phone')).toBeTruthy())

    // `p_old-laptop` is on the match but no longer in the directory — a match outlives the name
    // claims of the people who played it, and the select must not silently retarget the row.
    const seatA = screen.getByLabelText('Player in seat A of ABC123')
    expect(seatA).toHaveProperty('value', 'p_old-laptop')
    expect(within(seatA).getByText('p_old-laptop')).toBeTruthy()
  })

  it('shows the rosters, so the match being edited is recognisable', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    // A room code and a date do not identify a game a month later; what was drafted does.
    expect(screen.getByText('Barbarian')).toBeTruthy()
    expect(screen.getByText('banned Seraph')).toBeTruthy()
  })
})
