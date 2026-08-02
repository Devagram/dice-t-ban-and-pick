import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { Leaderboard } from '../src/screens/Leaderboard.js'

/**
 * D29's table.
 *
 * Draws get their own column rather than counting as half a win — D21 makes 1½–1½ a real terminal
 * state, and folding it into wins would describe a different game on the screen from the one that
 * was played.
 */

const STANDINGS = [
  { playerId: 'p-tom', name: 'Tom', wins: 7, losses: 3, draws: 1 },
  { playerId: 'p-alex', name: 'Alex', wins: 5, losses: 4, draws: 0 },
]

beforeEach(() => {
  cleanup()
  localStorage.clear()
  localStorage.setItem('banpick:playerId', 'p-alex')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ standings: STANDINGS }))),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('the standings read at a glance', () => {
  it('lists players in order with wins, losses and draws apart', async () => {
    render(<Leaderboard onBack={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())
    const rows = [...document.querySelectorAll('.table__row:not(.table__row--head)')]
    expect(rows).toHaveLength(2)

    const numbers = [...rows[0]!.querySelectorAll('.table__num')].map((n) => n.textContent)
    // W / L / D as three columns: a draw is not half a win.
    expect(numbers).toEqual(['7', '3', '1'])
  })

  it('marks which row is you, so you need not read every name', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Alex')).toBeTruthy())

    const mine = document.querySelector('.table__row--you')!
    expect(mine.textContent).toContain('Alex')
    expect(document.querySelectorAll('.table__row--you')).toHaveLength(1)
  })

  it('says so plainly when nobody has played yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ standings: [] }))),
    )
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Nothing yet/)).toBeTruthy())
    // And explains what to do about it, rather than showing an empty table.
    expect(screen.getByText(/both players named/)).toBeTruthy()
  })

  it('surfaces a failure rather than hanging on "Loading…"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('offers a way back', async () => {
    const onBack = vi.fn()
    render(<Leaderboard onBack={onBack} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
  })
})
