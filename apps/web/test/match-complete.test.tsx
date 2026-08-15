import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PlayerView } from '@banpick/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { view } from './fixtures.js'

/**
 * The whole match screen at a terminal state, rather than one component in isolation.
 *
 * Written because "play again does not show" was reported against a build where every unit test
 * for it passed — which is exactly the gap a component test cannot see: the button is only real
 * if the screen that owns it renders it under the props the transport actually produces.
 */

type Patch = Partial<{
  status: string
  view: PlayerView | null
  rematch: { roomCode: string; by: string } | null
}>

let emit: (patch: Patch) => void = () => {}

vi.mock('../src/transport.js', () => ({
  connect: (_url: string, _token: string, onChange: (patch: Patch) => void) => {
    emit = onChange
    return { send: () => {}, close: () => {}, reportProgress: () => {} }
  },
}))

const { Match } = await import('../src/screens/Match.js')

afterEach(cleanup)

function mount() {
  render(<Match roomCode="ABC123" seatToken="tok" websocketUrl="ws://x" />)
}

describe('the end of a match', () => {
  it('offers a rematch once the match is complete', async () => {
    mount()
    emit({ status: 'open', view: view({ status: 'COMPLETE', outcome: 'A' }) })

    await waitFor(() => expect(screen.getByText('You win the match')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Play again' })).toBeTruthy()
  })

  it('does not offer one mid-match', async () => {
    mount()
    emit({ status: 'open', view: view({ status: 'IN_PROGRESS' }) })

    await waitFor(() => expect(screen.getByText(/You are seat/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Play again' })).toBeNull()
  })

  it("shows the opponent's rematch once it arrives over the socket", async () => {
    mount()
    const v = view({ status: 'COMPLETE', outcome: 'A' })
    emit({ status: 'open', view: v })
    // The frame the finished match pushes to the other seat — the only channel they still share.
    emit({ rematch: { roomCode: 'NEW123', by: v.seat === 'A' ? 'B' : 'A' } })

    const link = await screen.findByRole('link', { name: 'Join the rematch' })
    expect(link.getAttribute('href')).toBe('/j/NEW123')
  })

  it('keeps the offer visible when a later view arrives', async () => {
    mount()
    const v = view({ status: 'COMPLETE', outcome: 'A' })
    emit({ status: 'open', view: v })
    emit({ rematch: { roomCode: 'NEW123', by: v.seat === 'A' ? 'B' : 'A' } })
    await screen.findByRole('link', { name: 'Join the rematch' })

    // A VIEW frame clears `progress` by design. It must not clear this: the offer stays true,
    // and the server re-broadcasts views for reasons that have nothing to do with the rematch.
    emit({ view: view({ status: 'COMPLETE', outcome: 'A' }) })
    expect(screen.getByRole('link', { name: 'Join the rematch' })).toBeTruthy()
  })
})
