import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NewTournament } from '../src/screens/NewTournament.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * **D37 Phase 9 — the screen that makes the tournament layer reachable.**
 *
 * Most of it is a form and not worth a test. Two parts are:
 *
 * - **Who an entrant is.** A player id belongs to a browser (D35) and the organizer is not sitting
 *   at it, so a typed name is matched against the people this deployment already knows. Getting
 *   this wrong means a regular's tournament results land on a second identity — the exact problem
 *   D35 exists to clean up, manufactured on purpose.
 * - **The handover.** The organizer key and the entrant links are minted once and stored only as
 *   hashes. Anything this screen fails to show is gone.
 */

const MATCHUPS = [
  {
    a: { id: 'p_real_tom', name: 'Tom' },
    b: { id: 'p_real_alex', name: 'Alex' },
    aWins: 1,
    bWins: 1,
    draws: 0,
    played: 2,
  },
]

const MODES = [
  { modeId: 'base', label: 'Best of 3', parameters: {} },
  { modeId: 'bo1-bring3-ban1', label: 'Best of 1', parameters: {} },
]

/** Serves the two reads the screen makes, and records the create it posts. */
function serve() {
  const posted: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({ url: String(url), body: JSON.parse(String(init.body)) as unknown })
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 'T-ABC123',
              url: 'https://example.com/t/T-ABC123',
              organizerToken: 'organiser-token-value',
              entrants: [
                {
                  entrantId: 't1',
                  displayName: 'Tom',
                  seed: 1,
                  url: 'https://example.com/t/T-ABC123#tok1',
                },
                {
                  entrantId: 't2',
                  displayName: 'Newcomer',
                  seed: 2,
                  url: 'https://example.com/t/T-ABC123#tok2',
                },
              ],
            }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(String(url).includes('matchups') ? { matchups: MATCHUPS } : MODES),
      } as Response)
    }),
  )
  return posted
}

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Entrants, one name per line'), { target: { value } })

describe('entering people who have no accounts', () => {
  it('reuses a known player’s id and mints one for a stranger, saying which is which', async () => {
    const posted = serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('Tom\nNewcomer')

    // Said before creating, not discovered afterwards on the leaderboard.
    expect(screen.getByText('known player')).toBeTruthy()
    expect(screen.getByText('new — will not join an existing record')).toBeTruthy()

    fireEvent.click(screen.getByText('Create tournament'))
    await waitFor(() => expect(posted.length).toBe(1))

    const body = posted[0]!.body as { entrants: { playerId: string; displayName: string }[] }
    // The real id off the public history, so a regular's bracket games count towards the record
    // they already have.
    expect(body.entrants[0]).toEqual({ playerId: 'p_real_tom', displayName: 'Tom' })
    expect(body.entrants[1]!.playerId).not.toBe('p_real_tom')
    expect(body.entrants[1]!.playerId).toMatch(/^p_/)
  })

  it('matches a known name whatever case it is typed in', async () => {
    serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('  tom  \nAlex')
    // Two known players — nobody types their friends' names the way the database has them.
    expect(screen.getAllByText('known player').length).toBe(2)
  })

  it('refuses to create a bracket with somebody in it twice', async () => {
    serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('Tom\nTom')
    expect(screen.getByText(/entered twice/)).toBeTruthy()
    expect(screen.getByText('Create tournament').hasAttribute('disabled')).toBe(true)
  })

  it('will not create one out of a single name', async () => {
    serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('Tom')
    expect(screen.getByText('Create tournament').hasAttribute('disabled')).toBe(true)
  })
})

describe('the config it sends', () => {
  it('sends an override only where a position differs from the default', async () => {
    const posted = serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('Tom\nAlex')
    fireEvent.click(screen.getByText('Double elimination'))
    fireEvent.change(screen.getByLabelText('Mode for Losers bracket'), {
      target: { value: 'bo1-bring3-ban1' },
    })
    fireEvent.click(screen.getByText('Create tournament'))
    await waitFor(() => expect(posted.length).toBe(1))

    const { config } = posted[0]!.body as {
      config: { format: string; overrides: Record<string, unknown>; grandFinalReset: boolean }
    }
    expect(config.format).toBe('DOUBLE_ELIMINATION')
    // The requirement in one assertion: a Bo1 losers bracket under a Bo3 winners bracket.
    expect(config.overrides).toEqual({ LOSERS: { modeId: 'bo1-bring3-ban1' } })
    // D40 — on unless it is turned off, and the final is left to fall back to the default.
    expect(config.grandFinalReset).toBe(true)
  })
})

describe('the handover', () => {
  it('shows the organiser key and every entrant link, because they exist nowhere else', async () => {
    serve()
    render(<NewTournament onBack={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Mode for Every match')).toBeTruthy())

    type('Tom\nNewcomer')
    fireEvent.click(screen.getByText('Create tournament'))

    await waitFor(() => expect(screen.getByText('organiser-token-value')).toBeTruthy())
    expect(screen.getByText('https://example.com/t/T-ABC123#tok1')).toBeTruthy()
    expect(screen.getByText('https://example.com/t/T-ABC123#tok2')).toBeTruthy()

    // And all of it again in one block, because handing these out means pasting them somewhere.
    const block = screen.getByLabelText('Everything') as HTMLTextAreaElement
    expect(block.value).toContain('organiser-token-value')
    expect(block.value).toContain('#tok2')
  })
})
