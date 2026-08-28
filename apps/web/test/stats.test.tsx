import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Leaderboard } from '../src/screens/Leaderboard.js'

/**
 * **D50 — the fun ones, on screen.**
 *
 * These are the numbers most likely to be quoted at somebody across a table, so the page's job is
 * to be quotable without being wrong: the sample sits above the superlatives, a card with nothing
 * in it says so rather than vanishing, and "banned against them" stays a fact about the player it
 * names rather than about whoever typed it.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const STATS = {
  matches: 11,
  picked: [
    { characterId: 'thor', count: 9 },
    { characterId: 'moon-elf', count: 7 },
  ],
  played: [{ characterId: 'thor', count: 6 }],
  benched: [{ characterId: 'treant', count: 4 }],
  banned: [
    { characterId: 'krampus', count: 5 },
    { characterId: 'thor', count: 3 },
  ],
  stolen: [{ characterId: 'krampus', count: 2 }],
  mirrored: [],
  denied: [{ characterId: 'moon-elf', count: 6 }],
  counterPicked: [{ characterId: 'ninja', count: 4 }],
  answered: [{ characterId: 'thor', count: 5 }],
  sequentialRounds: 14,
  players: [
    {
      playerId: 'p-tom',
      name: 'Tom',
      matches: 8,
      picked: [{ characterId: 'thor', count: 6 }],
      banned: [{ characterId: 'krampus', count: 4 }],
      bannedAgainst: [{ characterId: 'moon-elf', count: 3 }],
    },
    {
      playerId: 'p-alex',
      name: 'Alex',
      matches: 5,
      picked: [{ characterId: 'ninja', count: 3 }],
      banned: [{ characterId: 'thor', count: 2 }],
      bannedAgainst: [{ characterId: 'krampus', count: 1 }],
    },
  ],
}

const ROSTER = {
  rosterVersion: '2026.08.28-1',
  characters: [
    { id: 'thor', name: 'Thor', blurb: '', status: 'ACTIVE' },
    { id: 'moon-elf', name: 'Moon Elf', blurb: '', status: 'ACTIVE' },
    { id: 'krampus', name: 'Krampus', blurb: '', status: 'ACTIVE' },
    { id: 'ninja', name: 'Ninja', blurb: '', status: 'ACTIVE' },
    // `treant` is deliberately absent — a record outlives the roster entry of a retired character.
  ],
}

function serve(over: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(over).find((k) => url.includes(k))
    if (key) return new Response(JSON.stringify(over[key]))
    if (url.includes('/api/stats')) return new Response(JSON.stringify(STATS))
    if (url.includes('/api/roster')) return new Response(JSON.stringify(ROSTER))
    return new Response(JSON.stringify({ standings: [] }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The card with this heading. `HTMLElement` because `within` takes one and `querySelectorAll`
    hands back the base `Element`. */
const card = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.statcard')].find(
    (c) => c.querySelector('.statcard__title')?.textContent === title,
  )!

describe('the stats board', () => {
  it('is the leaderboard’s third tab, with a URL of its own', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)

    // Three answers to "how are we doing", not three pages — and each one still pastable.
    const tab = screen.getByRole('link', { name: 'Stats' })
    expect(tab.getAttribute('href')).toBe('/stats')
    expect(tab.getAttribute('aria-current')).toBe('page')
    expect(await screen.findByText('Most picked')).toBeTruthy()
  })

  it('puts the sample above the superlatives', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)

    // "Most hated" over eleven matches is a fact about one evening, and printing the sample beside
    // it is the difference between a fun statistic and a wrong one.
    expect(await screen.findByText(/Counted over 11 recorded matches/)).toBeTruthy()
  })

  it('names the leader of each card and the runners-up under it', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await screen.findByText('Most picked')

    const picked = card('Most picked')
    expect(within(picked).getByText('Thor')).toBeTruthy()
    expect(within(picked).getByText('9 drafts')).toBeTruthy()
    // The runner-up is the point rather than padding: it shows whether the top was a landslide.
    expect(within(picked).getByText('Moon Elf')).toBeTruthy()

    const hated = card('Most hated')
    expect(within(hated).getByText('Krampus')).toBeTruthy()
    expect(within(hated).getByText('5 bans')).toBeTruthy()
  })

  it('keeps a card that has never happened, rather than dropping it', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await screen.findByText('Most picked')

    // Nobody has mirrored a draft here, and which of these has never happened is itself worth
    // knowing — a card that vanished would read as a stat the page forgot.
    expect(within(card('Most mirrored')).getByText('Nobody yet.')).toBeTruthy()
  })

  it('names a hero the roster has forgotten rather than showing its id', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await screen.findByText('Most picked')

    // D14 retires rather than deletes, but a record outliving its roster entry still has to read.
    expect(within(card('Most benched')).getByText('Treant')).toBeTruthy()
  })

  it('shows nothing about a player until one is chosen', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await screen.findByText('Most picked')

    expect(screen.getByLabelText('Whose habits')).toBeTruthy()
    expect(screen.queryByText('They ban')).toBeNull()
  })

  it('answers what a player brings, bans, and is banned for', async () => {
    serve()
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await screen.findByText('Most picked')

    fireEvent.change(screen.getByLabelText('Whose habits'), { target: { value: 'p-tom' } })

    expect(within(card('Tom bring')).getByText('Thor')).toBeTruthy()
    expect(within(card('They ban')).getByText('Krampus')).toBeTruthy()
    /*
     * The one nobody can look up any other way: what Tom is *known for* is what other people ban
     * against him, which is a fact about Tom rather than about whoever typed it.
     */
    expect(within(card('Banned against them')).getByText('Moon Elf')).toBeTruthy()
  })

  it('says so plainly before anything has been played', async () => {
    serve({ '/api/stats': { ...STATS, matches: 0 } })
    render(<Leaderboard board="stats" onBack={vi.fn()} />)

    expect(await screen.findByText(/Nothing yet/)).toBeTruthy()
  })

  it('surfaces a failure rather than hanging on "Loading…"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    render(<Leaderboard board="stats" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})
