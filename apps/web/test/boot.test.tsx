import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { App } from '../src/App.js'
import { ROSTER } from './fixtures.js'

/**
 * Does the app actually boot?
 *
 * Every other client test renders one component with a hand-built view. None of them would
 * catch a crash in routing, in an effect, or in the first paint — the failure mode where a
 * player opens the link and gets a white screen, which is indistinguishable from the server
 * being down and is the worst possible thing to debug over a table.
 *
 * So this mounts the real `App`, at each real route, against a stubbed network.
 */

const MODES = [
  {
    modeId: 'base',
    label: 'Standard Bo3 — draft ${draftCount}',
    parameters: { draftCount: { values: [3, 4], default: 4, label: 'Characters drafted' } },
  },
]

function stubNetwork(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = url.includes('/api/modes')
        ? MODES
        : url.includes('/api/roster')
          ? { rosterVersion: '2026.07.28-1', characters: ROSTER }
          : url.includes('/preview')
            ? {
                roomCode: 'ABC123',
                modeLabel: 'Standard Bo3 — draft 4',
                ruleset: {
                  modeId: 'base',
                  parameters: { draftCount: 4 },
                  rosterVersion: '2026.07.28-1',
                  globalBanned: ['anvil'],
                  constraints: { crossSeatMirrors: 'ALLOWED', selfDuplicates: 'FORBIDDEN' },
                  onTie: { scoring: 'HALF_POINT', consumesCharacters: true },
                  match: { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true },
                  overtime: { enabled: false },
                  modeContentHash: 'abc123def456',
                },
                globalBannedCharacters: [ROSTER[0]],
                roster: ROSTER,
                seatsAvailable: ['A', 'B'],
                status: 'LOBBY',
              }
            : {}
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )

  // The match screen opens a socket on mount; it never connects here, which is itself worth
  // covering — a client that throws when the server is unreachable is a client that cannot
  // show its own reconnect banner.
  vi.stubGlobal(
    'WebSocket',
    class {
      static readonly OPEN = 1
      readyState = 0
      addEventListener(): void {}
      close(): void {}
      send(): void {}
    },
  )
}

beforeEach(() => {
  localStorage.clear()
  stubNetwork()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function goTo(path: string, hash = ''): void {
  history.replaceState(null, '', `${path}${hash}`)
}

describe('the app boots', () => {
  it('renders the home screen with the host controls', async () => {
    goTo('/')
    render(<App />)

    expect(screen.getByText('Ban & Pick')).toBeTruthy()
    expect(screen.getByText('Start a match')).toBeTruthy()
    expect(screen.getByText('Join a match')).toBeTruthy()

    // The parameter space comes from the server, so the buttons only exist once it answers.
    await waitFor(() => expect(screen.getByRole('button', { name: '3' })).toBeTruthy())
    expect(screen.getByRole('button', { name: '4' })).toBeTruthy()

    // And the roster, for the optional global ban list.
    await waitFor(() => expect(screen.getByRole('button', { name: 'The Anvil' })).toBeTruthy())
  })

  it('renders the lobby for a join link, with the full ruleset before any seat button', async () => {
    goTo('/j/ABC123')
    render(<App />)

    await waitFor(() => expect(screen.getByText('Standard Bo3 — draft 4')).toBeTruthy())

    // §12.3 — seating is the consent, so the rules are on screen before the button that
    // accepts them.
    expect(screen.getByText('Characters drafted')).toBeTruthy()
    expect(screen.getByText('Half a point each')).toBeTruthy()
    expect(screen.getByText('The Anvil')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Take a seat' })).toBeTruthy()
  })

  it('takes a resume link straight into the match, and strips the token from the URL', async () => {
    goTo('/r/ABC123', '#deadbeef')
    render(<App />)

    // The token is a bearer credential (D17). It arrives in the fragment so it never reaches a
    // request log, and it is removed from the address bar so a screenshot is not a handover.
    await waitFor(() => expect(location.pathname).toBe('/j/ABC123'))
    expect(location.hash).toBe('')

    // Still connecting — but rendering, not blank.
    expect(screen.getByText(/Joining match ABC123/)).toBeTruthy()
  })

  it('reconnects a returning player without asking anything of them (D17)', async () => {
    localStorage.setItem(
      'banpick:seat:ABC123',
      JSON.stringify({ seatToken: 'deadbeef', websocketUrl: 'ws://x/api/match/ABC123/ws' }),
    )
    goTo('/j/ABC123')
    render(<App />)

    // A stored seat means the lobby is skipped entirely: no "take a seat" to press again.
    await waitFor(() => expect(screen.getByText(/Joining match ABC123/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Take a seat' })).toBeNull()
  })

  it('shows a connection banner rather than a blank screen when the server is unreachable', async () => {
    goTo('/j/ABC123')
    localStorage.setItem(
      'banpick:seat:ABC123',
      JSON.stringify({ seatToken: 'deadbeef', websocketUrl: 'ws://x/api/match/ABC123/ws' }),
    )
    render(<App />)

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('Connecting')
  })
})
