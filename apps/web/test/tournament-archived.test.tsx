import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TournamentView } from '../src/api.js'
import { Tournament } from '../src/screens/Tournament.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * **D37 Phase 8 — the page a finished tournament keeps.**
 *
 * Seven days after its last activity the tournament's Durable Object deletes itself (D42), and the
 * bracket is served from the registry's archive instead. Two things follow from that and both are
 * worth holding: the page has to say it is a record rather than claim to be watching one, and it
 * must not open a socket to an object that no longer exists.
 */

const FINISHED: TournamentView = {
  code: 'T-ABC123',
  status: 'COMPLETE',
  format: 'SINGLE_ELIMINATION',
  grandFinalReset: false,
  createdAt: Date.now() - 30 * 86400000,
  entrants: [1, 2].map((i) => ({
    entrantId: `t${i}`,
    playerId: `p${i}`,
    displayName: `Player ${i}`,
    seed: i,
  })),
  slots: [
    {
      slot: { id: 'W1M1', side: 'WINNERS', round: 1, match: 1, winnerTo: null, loserTo: null },
      status: 'DONE',
      entrants: ['t1', 't2'],
      winner: 't1',
      position: 'WINNERS',
      modeId: 'base',
      roomCode: null,
    },
  ],
  champion: 't1',
  complete: true,
}

/** Serves one tournament read and counts every socket the screen tries to open. */
function serve(view: TournamentView) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(view) } as Response)),
  )
  const opened: string[] = []
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        opened.push(url)
      }
      addEventListener() {}
      close() {}
    },
  )
  return opened
}

describe('an archived tournament', () => {
  it('opens no socket, and says it is archived rather than reconnecting', async () => {
    const opened = serve({ ...FINISHED, archived: true })
    render(<Tournament code="T-ABC123" onBack={() => {}} />)

    await waitFor(() => expect(screen.getByText('Archived')).toBeTruthy())
    // "Reconnect" would be a promise to a reader that this might yet update. Nothing will.
    expect(screen.queryByText('Reconnect')).toBeNull()
    expect(opened).toEqual([])

    // And it is a whole page, not a stub: the bracket it kept is the point of keeping it.
    expect(screen.getByText('Player 1 wins.')).toBeTruthy()
    expect(document.querySelector('g.bslot[data-slot="W1M1"]')).toBeTruthy()
  })

  it('still watches a tournament that is merely finished', async () => {
    // Finished is not archived. The object is alive for another week, D39 can still correct it,
    // and a page that stopped listening would show a result that has since been overturned.
    const opened = serve(FINISHED)
    render(<Tournament code="T-ABC123" onBack={() => {}} />)

    await waitFor(() => expect(opened.length).toBe(1))
    expect(opened[0]).toContain('/api/tournament/T-ABC123/ws')
  })
})
