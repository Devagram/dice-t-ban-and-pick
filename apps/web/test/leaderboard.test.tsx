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
  {
    playerId: 'p-tom',
    name: 'Tom',
    wins: 7,
    losses: 3,
    draws: 1,
    roundWins: 16,
    roundLosses: 9,
    roundDraws: 2,
  },
  {
    playerId: 'p-alex',
    name: 'Alex',
    wins: 5,
    losses: 4,
    draws: 0,
    roundWins: 11,
    roundLosses: 13,
    roundDraws: 1,
  },
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
  it('lists players in order, with matches and rounds counted separately', async () => {
    render(<Leaderboard onBack={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())
    const rows = [
      ...document.querySelectorAll('.table__row:not(.table__row--head):not(.table__row--sub)'),
    ]
    expect(rows).toHaveLength(2)

    // Matches W/L/D, then rounds W/L/D. A 2–1 win is one match and three rounds, and the two
    // answer different questions — draws stay their own column in both.
    const numbers = [...rows[0]!.querySelectorAll('.table__num')].map((n) => n.textContent)
    expect(numbers).toEqual(['7', '3', '1', '16', '9', '2'])
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

/**
 * What the 2026-08-28 rebuild has to keep true.
 *
 * The screen was a list of rows with two `aria-hidden` header rows over it, and both halves of
 * that were the same bug: nothing labelled which of six single-letter columns you were reading,
 * and a screen reader was handed the numbers with the headers hidden. These are about the table
 * still being a table — not about how it looks, which is CSS and not something a test should
 * pretend to check.
 */
describe('the standings are readable, by eye and by screen reader', () => {
  it('is a real table with named columns', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    // The headers were `aria-hidden` when they were two decorative rows. A column nobody can name
    // is a column of unlabelled numbers to anyone not looking at it.
    const columns = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(columns).toEqual(['#Rank', 'Player', 'MatchesW–L–D', 'RoundsW–L–D'])
    expect(screen.getByRole('table', { name: /standings/i })).toBeTruthy()
  })

  it('joins each record into one figure rather than three columns', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    const [matches, rounds] = [
      ...document.querySelectorAll('.table__row:not(.table__row--head) .table__record'),
    ]
    // Read as a record — the separators are decoration, so they are the one thing here hidden
    // from the accessibility tree rather than announced as "dash".
    expect(matches!.textContent).toBe('7–3–1')
    expect(rounds!.textContent).toBe('16–9–2')
    const separators = [...matches!.querySelectorAll('.table__sep')]
    expect(separators.every((sep) => sep.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('dims a zero instead of dropping it, so the columns still line up', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Alex')).toBeTruthy())

    // Alex has no draws. The digit stays — a record missing its third number is unreadable
    // against one that has it — and loses its weight instead.
    const alex = document.querySelectorAll('.table__row:not(.table__row--head)')[1]!
    const drawn = alex.querySelectorAll('.table__num')[2]!
    expect(drawn.textContent).toBe('0')
    expect(drawn.className).toContain('table__num--nil')
    expect(alex.querySelectorAll('.table__num')[0]!.className).not.toContain('table__num--nil')
  })

  it('draws the share of a record in proportion, and says nothing to a screen reader', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    // Tom: 7–3–1 of 11 matches, wins first from the left.
    const bar = document.querySelector('.table__row:not(.table__row--head) .table__share')!
    expect(bar.getAttribute('aria-hidden')).toBe('true')
    const widths = [...bar.querySelectorAll('.table__seg')].map(
      (seg) => (seg as HTMLElement).style.width,
    )
    expect(widths[0]).toBe(`${(7 / 11) * 100}%`)
    expect(widths).toHaveLength(3)

    // Alex drew nothing, so there is no draw segment to draw — a zero-width sliver would read as
    // a result nobody had.
    const alexBar = document.querySelectorAll('.table__share')[1]!
    expect(alexBar.querySelectorAll('.table__seg')).toHaveLength(2)
  })

  it('marks first place without repainting the whole row', async () => {
    render(<Leaderboard onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    const rows = [...document.querySelectorAll('.table__row:not(.table__row--head)')]
    expect(rows[0]!.className).toContain('table__row--lead')
    expect(rows[1]!.className).not.toContain('table__row--lead')
  })
})
