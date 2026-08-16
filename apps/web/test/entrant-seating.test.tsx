import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LobbyPreview } from '@banpick/types'

import { Lobby } from '../src/screens/Lobby.js'
import { RULESET } from './fixtures.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  history.replaceState(null, '', '/')
})

/**
 * **D41 — an entrant taking their reserved seat, from the real client.**
 *
 * The bug these exist for: the tournament page links an entrant to `/j/CODE#token`, and the lobby
 * dropped the fragment. Every entrant was told "this seat is reserved — open the match from your
 * entrant link" having done exactly that, and the whole tournament layer was unplayable from a
 * browser. The worker suite plays entire tournaments and never caught it, because its test client
 * sends the token itself — it could do something the real client could not.
 */

const preview = (over: Partial<LobbyPreview> = {}): LobbyPreview => ({
  roomCode: 'ABC123',
  modeLabel: 'Standard Bo3 — draft 4',
  ruleset: RULESET,
  globalBannedCharacters: [],
  roster: [],
  seatsAvailable: ['A', 'B'],
  status: 'LOBBY',
  ...over,
})

/** Serves one preview and records the seat claim. */
function serve(view: LobbyPreview) {
  const claims: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).includes('/seat')) {
        claims.push(JSON.parse(String(init?.body)))
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              seat: 'A',
              seatToken: 'seat-token',
              resumeUrl: '/r/ABC123#seat-token',
              websocketUrl: 'ws://x/api/match/ABC123/ws',
            }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(view) } as Response)
    }),
  )
  return claims
}

const BRACKET = { code: 'T-ABC123', slotId: 'W1M1' }

describe('an entrant arriving with their link', () => {
  it('sends the entrant token with the seat claim', async () => {
    history.replaceState(null, '', '/j/ABC123#entrant-token-value')
    const claims = serve(preview({ tournament: BRACKET }))
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Take a seat' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Take a seat' }))

    await waitFor(() => expect(claims).toHaveLength(1))
    expect(claims[0]).toMatchObject({ entrantToken: 'entrant-token-value' })
  })

  it('does not ask for a name the tournament already has', async () => {
    history.replaceState(null, '', '/j/ABC123#entrant-token-value')
    serve(preview({ tournament: BRACKET }))
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Take a seat' })).toBeTruthy())
    // The seat is filled under the entrant's *registered* identity (D41), so a name typed here
    // would be collected and discarded — and requiring one would block the seat on it.
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(screen.getByRole('button', { name: 'Take a seat' }).hasAttribute('disabled')).toBe(false)
  })

  it('takes the token out of the address bar once the seat is held', async () => {
    history.replaceState(null, '', '/j/ABC123#entrant-token-value')
    serve(preview({ tournament: BRACKET }))
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Take a seat' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Take a seat' }))

    // The same treatment D17 gives a resume token: it opens this seat for the length of the
    // event, and a screenshot of the address bar should not hand that over.
    await waitFor(() => expect(location.hash).toBe(''))
    expect(location.pathname).toBe('/j/ABC123')
  })
})

describe('somebody arriving at a bracket match without one', () => {
  it('is told so before typing anything, and pointed at the bracket', async () => {
    history.replaceState(null, '', '/j/ABC123')
    serve(preview({ tournament: BRACKET }))
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByText(/Both seats are held/)).toBeTruthy())
    // Not a form that fails on the click: no seat button, no name field, and somewhere to go.
    expect(screen.queryByRole('button', { name: 'Take a seat' })).toBeNull()
    expect(screen.queryByLabelText('Your name')).toBeNull()
    expect(screen.getByRole('link', { name: 'See the bracket' }).getAttribute('href')).toBe(
      '/t/T-ABC123',
    )
  })

  it('is offered no invite link, because there is nobody to invite', async () => {
    history.replaceState(null, '', '/j/ABC123')
    serve(preview({ tournament: BRACKET }))
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByText(/Both seats are held/)).toBeTruthy())
    expect(screen.queryByLabelText('Invite link')).toBeNull()
  })
})

describe('an ordinary room is untouched', () => {
  it('still asks for a name, still shares a link, and sends no token', async () => {
    history.replaceState(null, '', '/j/ABC123')
    const claims = serve(preview())
    render(<Lobby roomCode="ABC123" onSeated={() => {}} />)

    await waitFor(() => expect(screen.getByLabelText('Your name')).toBeTruthy())
    expect(screen.getByLabelText('Invite link')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Tom' } })
    fireEvent.click(screen.getByRole('button', { name: 'Take a seat' }))

    await waitFor(() => expect(claims).toHaveLength(1))
    expect(claims[0]).toMatchObject({ displayName: 'Tom' })
    expect(claims[0]).not.toHaveProperty('entrantToken')
  })
})
