import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Organizer } from '../src/screens/Organizer.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/**
 * **D41 — the only recovery a lost entrant link has.**
 *
 * Tokens are handed over once at creation and stored as hashes, so "I have lost my link" cannot be
 * answered by looking it up. The endpoint for re-minting one has existed since Phase 3 and the
 * console never called it, which made a lost link the end of that entrant's tournament.
 */

const VIEW = {
  code: 'T-ABC123',
  status: 'RUNNING',
  format: 'SINGLE_ELIMINATION',
  grandFinalReset: false,
  createdAt: Date.now(),
  entrants: [
    { entrantId: 't1', playerId: 'p1', displayName: 'Tom', seed: 1 },
    { entrantId: 't2', playerId: 'p2', displayName: 'Alex', seed: 2 },
  ],
  slots: [],
  champion: null,
  complete: false,
}

function serve() {
  const posted: { url: string; key: string | null; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push({
          url: String(url),
          key: new Headers(init.headers).get('x-organizer-key'),
          body: JSON.parse(String(init.body)) as unknown,
        })
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, entrantId: 't1', entrantToken: 'fresh-token' }),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(VIEW) } as Response)
    }),
  )
  return posted
}

const withKey = async () => {
  fireEvent.change(screen.getByLabelText('Organiser key'), { target: { value: 'org-key' } })
}

describe('re-issuing an entrant link', () => {
  it('asks twice, then shows the new link', async () => {
    const posted = serve()
    render(<Organizer code="T-ABC123" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('Entrant links')).toBeTruthy())
    await withKey()

    // Two steps, like every other action on this screen: the entrant's current link stops working
    // the instant this lands, including on a match they are already sitting in.
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-issue link' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /Really replace Tom/ }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]!.url).toContain('/api/tournament/T-ABC123/relink')
    expect(posted[0]!.key).toBe('org-key')
    // Only the entrant id: same person, new link. Sending a player id here would be a
    // substitution, which is a different act with a different button.
    expect(posted[0]!.body).toEqual({ entrantId: 't1' })

    const field = (await screen.findByLabelText('New link for Tom')) as HTMLInputElement
    expect(field.value).toBe(`${location.origin}/t/T-ABC123#fresh-token`)
  })

  it('cannot be pressed without the organiser key', async () => {
    serve()
    render(<Organizer code="T-ABC123" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('Entrant links')).toBeTruthy())

    // The server would refuse it anyway (Phase 7's allowlist); this stops the console offering an
    // action it knows will fail.
    for (const button of screen.getAllByRole('button', { name: 'Re-issue link' })) {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
  })

  it('says out loud that the old link is dead', async () => {
    serve()
    render(<Organizer code="T-ABC123" onBack={() => {}} />)
    await waitFor(() => expect(screen.getByText('Entrant links')).toBeTruthy())
    expect(screen.getByText(/stops the old one working immediately/)).toBeTruthy()
  })
})
