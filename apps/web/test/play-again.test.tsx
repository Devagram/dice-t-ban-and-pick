import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlayAgain } from '../src/components/PlayAgain.js'
import { recallSeat } from '../src/transport.js'
import { view } from './fixtures.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** A stubbed `location` that `wsUrlFor` can still read a scheme and a host out of. */
function stubLocation(): ReturnType<typeof vi.fn> {
  const assign = vi.fn()
  vi.stubGlobal('location', { assign, protocol: 'https:', host: 'banpick.example' })
  return assign
}

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

  it('walks you in when the server sent your seat with the offer', async () => {
    const assign = stubLocation()
    const v = done()

    /*
     * D53 — the opponent's path. They pressed nothing: the frame is the first they hear of the
     * rematch, and their seat is already in it. This is the whole of "you do not have to rejoin",
     * so it must happen without a click.
     */
    render(
      <PlayAgain
        view={v}
        roomCode="ABC123"
        seatToken="t"
        rematch={{ roomCode: 'NEW123', by: v.seat === 'A' ? 'B' : 'A', seatToken: 'mine' }}
      />,
    )

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/j/NEW123'))
    // Stored before navigating, because `/j/CODE` reads exactly this to tell a seated match from
    // a join page (D17) — and a token that only ever lived in a frame is one a closed tab loses.
    expect(recallSeat('NEW123')).toMatchObject({
      seatToken: 'mine',
      websocketUrl: 'wss://banpick.example/api/match/NEW123/ws',
    })
  })

  it('does not drag you out of a match an undo has reopened', async () => {
    const assign = stubLocation()

    /*
     * D15's undo reopens a completed match, and the rematch offer deliberately outlives a new
     * VIEW. Without the status gate the player who undid the result would be navigated away from
     * the match they just reopened, which is the opposite of what they asked for.
     */
    render(
      <PlayAgain
        view={view({ status: 'IN_PROGRESS' })}
        roomCode="ABC123"
        seatToken="t"
        rematch={{ roomCode: 'NEW123', by: 'B', seatToken: 'mine' }}
      />,
    )

    await Promise.resolve()
    expect(assign).not.toHaveBeenCalled()
  })

  it('takes the seat the server minted for the player who pressed the button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ roomCode: 'NEW123', seatToken: 'mine' }),
        }),
      ),
    )
    const assign = stubLocation()

    render(<PlayAgain view={done()} roomCode="ABC123" seatToken="tok" rematch={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/j/NEW123'))
    // The presser's token arrives in the HTTP response, which may be all they get: the socket
    // frame is a fan-out they might miss if their connection is mid-reconnect.
    expect(recallSeat('NEW123')).toMatchObject({ seatToken: 'mine' })
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
     * The fallback path, kept because pre-seating is allowed to fail — an anonymous seat in an old
     * match has no identity for the server to carry across. With no token there is no seat, so the
     * old wording is still the honest one: a link, and an opponent who has not joined yet.
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
