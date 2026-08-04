import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlayAgain } from '../src/components/PlayAgain.js'
import { view } from './fixtures.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const done = (over = {}) => view({ status: 'COMPLETE', outcome: 'A', ...over })

describe('play again', () => {
  it('is absent until the match is actually over', () => {
    // D15's undo reopens a completed match. Offering a rematch over a live one would point at a
    // room nobody is coming to.
    render(
      <PlayAgain
        view={view({ status: 'IN_PROGRESS' })}
        roomCode="ABC123"
        seatToken="t"
        rematch={null}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull()
  })

  it('opens a rematch and goes to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ roomCode: 'NEW123' }) }),
      ),
    )
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })

    render(<PlayAgain view={done()} roomCode="ABC123" seatToken="tok" rematch={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/j/NEW123'))
    // The seat token is what proves you played in this match, so it has to be sent.
    const url = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(url).toContain('/api/match/ABC123/rematch')
    expect(url).toContain('token=tok')
  })

  it('says who opened it when the offer came from the other seat', () => {
    const v = done()
    render(
      <PlayAgain
        view={v}
        roomCode="ABC123"
        seatToken="t"
        rematch={{ roomCode: 'NEW123', by: v.seat === 'A' ? 'B' : 'A' }}
      />,
    )

    // Named, not "your opponent" — the whole point of D29's names.
    expect(screen.getByText(/opened a rematch/)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Join the rematch' })
    expect(link.getAttribute('href')).toBe('/j/NEW123')
  })

  it('waits rather than claiming a seat for you when you opened it', () => {
    const v = done()
    render(
      <PlayAgain
        view={v}
        roomCode="ABC123"
        seatToken="t"
        rematch={{ roomCode: 'N1', by: v.seat }}
      />,
    )

    /*
     * §12.3 — seating is consent, and the app must not give it on anyone's behalf. So even the
     * player who pressed the button gets a link rather than a seat, and the opponent is described
     * as not-yet-joined rather than assumed in.
     */
    expect(screen.getByText(/Waiting for them to join/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to the rematch' })).toBeTruthy()
  })

  it('keeps the result on screen when opening one fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    )
    render(<PlayAgain view={done()} roomCode="ABC123" seatToken="t" rematch={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }))

    // A failed rematch must not read as a lost match.
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/result is still recorded/)).toBeTruthy()
    // And the button comes back, rather than staying stuck on "Opening…".
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play again' })).toBeTruthy())
  })
})
