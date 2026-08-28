import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Admin } from '../src/screens/Admin.js'

/**
 * **D49 — the tournaments panel.**
 *
 * Two controls, and the screen's job is to be clear about what each one costs: a delete closes the
 * tournament and releases its games rather than deleting them, and a rename is refused on an event
 * that is still writing this record. Everything else about a tournament is derived from its
 * bracket and is not this screen's to state.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const FINISHED = {
  code: 'T-ABC234',
  format: 'SINGLE_ELIMINATION',
  entrants: ['Tomn', 'Alex'],
  champion: 'Tomn',
  createdAt: Date.now() - 86400000 * 3,
  updatedAt: Date.now() - 86400000 * 3,
  complete: true,
}

const RUNNING = {
  code: 'T-DEF345',
  format: 'DOUBLE_ELIMINATION',
  entrants: ['Sam', 'Kim'],
  champion: null,
  createdAt: Date.now() - 3600000,
  updatedAt: Date.now() - 3600000,
  complete: false,
}

function serve(over: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    const path = String(url)
    const key = Object.keys(over).find((k) => path.includes(k))
    const body =
      key !== undefined
        ? over[key]
        : path.includes('/api/tournaments')
          ? { tournaments: [FINISHED, RUNNING] }
          : path.includes('/api/admin/players')
            ? { players: [] }
            : path.includes('/api/roster')
              ? { rosterVersion: 'x', characters: [] }
              : path.includes('/api/admin/deleteTournament')
                ? { ok: true, released: 3 }
                : path.includes('/api/admin/renameEntrant')
                  ? { ok: true, tournaments: [{ ...FINISHED, entrants: ['Tom', 'Alex'] }] }
                  : { matches: [] }
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

const keyed = async (fetchMock: ReturnType<typeof serve>) => {
  fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
  await screen.findByLabelText('Player in seat A')
  return fetchMock
}

describe('the tournaments panel', () => {
  it('lists what each one is, without a key', async () => {
    serve()
    render(<Admin onBack={() => {}} />)

    // Public to read, like the match list — the key gates changing it, not seeing it.
    expect(await screen.findByText('T-ABC234')).toBeTruthy()
    expect(screen.getByText('Tomn won')).toBeTruthy()
    expect(screen.getByText('still running')).toBeTruthy()
    expect(screen.getAllByText('Enter the admin key to edit.').length).toBeGreaterThan(0)
  })

  it('links each one to its own page', async () => {
    serve()
    render(<Admin onBack={() => {}} />)

    // The first thing anybody does before deleting a tournament is look at it — and afterwards
    // this is the 404 that confirms it went.
    const link = await screen.findByRole('link', { name: 'T-ABC234' })
    expect(link.getAttribute('href')).toBe('/t/T-ABC234')
  })

  it('asks twice before deleting, and says what a delete costs', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    const before = fetchMock.mock.calls.length
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    expect(fetchMock.mock.calls.length).toBe(before)
    // The games survive it, and somebody about to press this should know that before they do.
    expect(screen.getByText(/released from the bracket, not deleted/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Really delete T-ABC234' }))
    await waitFor(() => expect(() => call(fetchMock, '/api/admin/deleteTournament')).not.toThrow())
    const [, init] = call(fetchMock, '/api/admin/deleteTournament')
    expect((init.headers as Record<string, string>)['x-admin-key']).toBe('sekrit')
    expect(JSON.parse(String(init.body))).toEqual({ code: 'T-ABC234' })
  })

  it('reports how many matches the delete let go', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Really delete T-ABC234' }))

    // Only the server knows this number, so the notice is written from its answer rather than
    // before the request — "deleted" alone understates what happened to three matches.
    expect(await screen.findByText(/3 matches released from it, not deleted/)).toBeTruthy()
  })

  it('renames an entrant on a finished tournament', async () => {
    const fetchMock = serve()
    render(<Admin onBack={() => {}} />)
    await keyed(fetchMock)

    fireEvent.change(screen.getByLabelText('Entrant to rename in T-ABC234'), {
      target: { value: 'Tomn' },
    })
    fireEvent.change(screen.getByLabelText('New name in T-ABC234'), { target: { value: 'Tom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(() => call(fetchMock, '/api/admin/renameEntrant')).not.toThrow())
    expect(JSON.parse(String(call(fetchMock, '/api/admin/renameEntrant')[1].body))).toEqual({
      code: 'T-ABC234',
      from: 'Tomn',
      to: 'Tom',
    })
  })

  it('offers no rename on a running tournament, and says where to do it', async () => {
    serve()
    render(<Admin onBack={() => {}} />)
    await screen.findByText('T-DEF345')

    /*
     * Not hidden as a precaution: an unfinished tournament rewrites this record on every result,
     * so the rename would survive until the next one and then vanish. A control that is simply
     * absent reads as one this screen forgot, so the row says where the fix actually lives.
     */
    expect(screen.queryByLabelText('Entrant to rename in T-DEF345')).toBeNull()
    expect(screen.getByText(/rename an entrant from its organizer console/)).toBeTruthy()
    // The finished one still has its control.
    expect(screen.getByLabelText('Entrant to rename in T-ABC234')).toBeTruthy()
  })

  it('relays the server’s refusal in its own words', async () => {
    const fetchMock = serve()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('renameEntrant')) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () =>
              Promise.resolve({
                error: 'TOURNAMENT_RUNNING',
                detail: 'T-ABC234 is still running — rename from the organizer console instead.',
              }),
          } as Response)
        }
        return fetchMock(url)
      }),
    )
    render(<Admin onBack={() => {}} />)
    fireEvent.change(screen.getByLabelText('Admin key'), { target: { value: 'sekrit' } })
    await screen.findByLabelText('Entrant to rename in T-ABC234')

    fireEvent.change(screen.getByLabelText('Entrant to rename in T-ABC234'), {
      target: { value: 'Tomn' },
    })
    fireEvent.change(screen.getByLabelText('New name in T-ABC234'), { target: { value: 'Tom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))

    // "That did not go through" would be a dead end: the fix is on another page and only the
    // server's message says which.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('organizer console')
  })

  it('says so plainly when none have been run', async () => {
    serve({ '/api/tournaments': { tournaments: [] } })
    render(<Admin onBack={() => {}} />)

    expect(await screen.findByText('No tournaments have been run here.')).toBeTruthy()
  })
})
