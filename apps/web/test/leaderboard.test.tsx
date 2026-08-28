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
    render(<Leaderboard board="players" onBack={vi.fn()} />)

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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/Nothing yet/)).toBeTruthy())
    // And explains what to do about it, rather than showing an empty table.
    expect(screen.getByText(/both players named/)).toBeTruthy()
  })

  it('surfaces a failure rather than hanging on "Loading…"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    render(<Leaderboard board="players" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('offers a way back', async () => {
    const onBack = vi.fn()
    render(<Leaderboard board="players" onBack={onBack} />)
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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    // The headers were `aria-hidden` when they were two decorative rows. A column nobody can name
    // is a column of unlabelled numbers to anyone not looking at it.
    const columns = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(columns).toEqual(['#Rank', 'Player', 'MatchesW–L–D', 'RoundsW–L–D'])
    expect(screen.getByRole('table', { name: /standings/i })).toBeTruthy()
  })

  it('joins each record into one figure rather than three columns', async () => {
    render(<Leaderboard board="players" onBack={vi.fn()} />)
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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
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
    render(<Leaderboard board="players" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())

    const rows = [...document.querySelectorAll('.table__row:not(.table__row--head)')]
    expect(rows[0]!.className).toContain('table__row--lead')
    expect(rows[1]!.className).not.toContain('table__row--lead')
  })
})

/**
 * **D45 — the hero board, the leaderboard's other half.**
 *
 * The screen's job is narrow: render what the server ranked, in the order it ranked it, and be
 * straight about the two things the numbers do not say on their own — that a rate with one round
 * behind it is not what the board was sorted on, and that rounds from before the record kept a
 * lineup belong to nobody.
 */

const HEROES = {
  heroes: [
    {
      characterId: 'krampus',
      drafted: 3,
      played: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      best: [{ characterId: 'thor', wins: 1, losses: 0, draws: 0 }],
      worst: [],
    },
    {
      characterId: 'thor',
      drafted: 9,
      played: 8,
      wins: 4,
      losses: 2,
      draws: 1,
      best: [
        { characterId: 'moon-elf', wins: 3, losses: 0, draws: 1 },
        { characterId: 'treant', wins: 1, losses: 0, draws: 0 },
      ],
      worst: [{ characterId: 'krampus', wins: 0, losses: 1, draws: 0 }],
    },
    {
      characterId: 'moon-elf',
      drafted: 7,
      played: 6,
      wins: 2,
      losses: 3,
      draws: 1,
      best: [],
      worst: [{ characterId: 'thor', wins: 0, losses: 3, draws: 1 }],
    },
    {
      characterId: 'treant',
      drafted: 2,
      played: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      best: [],
      worst: [],
    },
  ],
  unattributedRounds: 12,
}

const ROSTER = {
  rosterVersion: '2026.08.28-1',
  characters: [
    { id: 'thor', name: 'Thor', blurb: '', status: 'ACTIVE' },
    { id: 'moon-elf', name: 'Moon Elf', blurb: '', status: 'ACTIVE' },
    { id: 'krampus', name: 'Krampus', blurb: '', status: 'ACTIVE' },
    // `treant` is deliberately absent: a match outlives the roster entry of a character that was
    // retired out of it, and the row still has to render.
  ],
}

/** Serves each endpoint the boards ask for; `over` replaces one of them. */
function serveBoards(over: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url)
    const key = Object.keys(over).find((k) => path.includes(k))
    if (key) return new Response(JSON.stringify(over[key]))
    if (path.includes('/api/heroes')) return new Response(JSON.stringify(HEROES))
    if (path.includes('/api/roster')) return new Response(JSON.stringify(ROSTER))
    return new Response(JSON.stringify({ standings: STANDINGS }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('the two boards', () => {
  it('offers both as links, marking the one you are on', () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)

    // Real links, like the front door's menu: each board is a URL that survives a bookmark and
    // being pasted to whoever you are arguing with.
    const players = screen.getByRole('link', { name: 'Players' })
    const heroes = screen.getByRole('link', { name: 'Heroes' })
    expect(players.getAttribute('href')).toBe('/leaderboard')
    expect(heroes.getAttribute('href')).toBe('/heroes')
    expect(heroes.getAttribute('aria-current')).toBe('page')
    expect(players.getAttribute('aria-current')).toBeNull()
  })

  it('shows the players board by default and the heroes board on request', async () => {
    serveBoards()
    const { unmount } = render(<Leaderboard board="players" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Tom')).toBeTruthy())
    expect(screen.queryByText('Thor')).toBeNull()
    unmount()

    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.hrow__name')).toBeTruthy())
    expect(screen.getAllByText('Thor').length).toBeGreaterThan(0)
    expect(screen.queryByText('Tom')).toBeNull()
  })
})

describe('the hero board', () => {
  const heroRows = () => [...document.querySelectorAll('.table__row:not(.table__row--head)')]

  /*
   * Waits on a row rather than on a name. A hero's name also appears in *other* heroes' matchup
   * chips — Thor is on the board and on Krampus's "beats" line — so `getByText('Thor')` finds
   * several elements and throws.
   */
  const loaded = () => waitFor(() => expect(document.querySelector('.hrow__name')).toBeTruthy())

  it('keeps the order the server ranked, and names the rule it used', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // The server's order, rendered as given — Krampus has won its only round and leads on that.
    // The screen sorts nothing; it explains what was sorted.
    expect(heroRows().map((r) => r.querySelector('.hrow__name')?.textContent)).toEqual([
      'Krampus',
      'Thor',
      'Moon Elf',
      'Treant',
    ])
    expect(screen.getByText(/share of rounds won/i)).toBeTruthy()
  })

  it('shows each hero’s record and the share of rounds it won', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    const thor = heroRows()[1]!
    expect(thor.querySelector('.table__record')!.textContent).toBe('4–2–1')
    // 4 of 7 rounds. Draws are beside it rather than folded into it, which is what makes this a
    // share of rounds won rather than an answer to "is a draw half a win?".
    expect(thor.querySelector('.table__rate')!.textContent).toBe('57%')
  })

  it('shows a rate for one round and none at all for none', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // A rate is a rate whatever the sample, and the `1–0–0` beside it is what says how much to
    // read into this one.
    expect(heroRows()[0]!.querySelector('.table__rate')!.textContent).toBe('100%')
    expect(heroRows()[0]!.querySelector('.table__record')!.textContent).toBe('1–0–0')

    // Drafted twice, never played: there is no rate to show, and a 0% would be a claim.
    expect(heroRows()[3]!.querySelector('.table__rate')!.textContent).toBe('—')
  })

  it('counts drafts the record has kept all along, and says which were benched', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // `drafted` reaches back over every match ever recorded, which is why it can exceed the
    // rounds beside it — and drafted-but-never-reached is the other half of what a pick meant.
    expect(heroRows()[1]!.querySelector('.hrow__drafted')!.textContent).toBe(
      'drafted 9 · benched 1',
    )
    expect(heroRows()[3]!.querySelector('.hrow__drafted')!.textContent).toBe(
      'drafted 2 · benched 2',
    )
  })

  it('names who each hero beats and who beats it, under it', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    const thor = heroRows()[1]!
    const line = (kind: 'best' | 'worst') => {
      const end = thor.querySelector(`.ends--${kind}`)!
      return {
        label: end.querySelector('.ends__label')!.textContent,
        chips: [...end.querySelectorAll('.ends__chip')].map((c) => c.textContent),
      }
    }

    // Ordered by the server, furthest ahead first, and the record travels with the name — "beats
    // Moon Elf" is worth much less than "beats Moon Elf 3–0–1".
    expect(line('best')).toEqual({ label: 'beats', chips: ['Moon Elf3–0–1', 'Treant1–0'] })
    expect(line('worst')).toEqual({ label: 'loses to', chips: ['Krampus0–1'] })
  })

  it('leaves out an end a hero has nothing to put in it', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // Moon Elf is up on nobody, and "beats: nobody" is a line of noise on every hero that has
    // only ever lost or played level.
    const moonElf = heroRows()[2]!
    expect(moonElf.querySelector('.ends--best')).toBeNull()
    expect(moonElf.querySelector('.ends--worst')).toBeTruthy()

    // Treant has never played a credited round, so it has neither.
    expect(heroRows()[3]!.querySelector('.ends')).toBeNull()
  })

  it('names an opponent the roster has forgotten rather than showing its id', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // `treant` is not in the roster fixture — the same prettied id its own row uses, so the two
    // places it appears agree.
    const chips = [...heroRows()[1]!.querySelectorAll('.ends__name')].map((c) => c.textContent)
    expect(chips).toContain('Treant')
  })

  it('says how much of the history it cannot credit to anybody', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // Without this the board reads as a group who have barely played, when in fact these are the
    // split matches a record with no lineup cannot settle — the rest of that history is deduced.
    expect(screen.getByText(/12 rounds are credited to nobody/i)).toBeTruthy()
    expect(screen.getByText(/one hero won and one lost/i)).toBeTruthy()
  })

  it('renders a hero the roster has forgotten rather than dropping the row', async () => {
    serveBoards()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await loaded()

    // D14 retires characters instead of deleting them, but a record outliving its roster entry is
    // the case this must not lose a row to — the id is prettied and the portrait simply omitted.
    // Named twice now: its own row, and Thor's list of who it loses to.
    expect(screen.getAllByText('Treant').length).toBeGreaterThan(0)
    expect(heroRows()[3]!.querySelector('.portrait')).toBeNull()
    expect(heroRows()[1]!.querySelector('.portrait')).toBeTruthy()
  })

  it('says so plainly when nothing has been drafted yet', async () => {
    serveBoards({ '/api/heroes': { heroes: [], unattributedRounds: 0 } })
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(/Nothing yet/)).toBeTruthy())
    expect(screen.getByText(/Draft a hero in a match/)).toBeTruthy()
  })

  it('surfaces a failure rather than hanging on "Loading…"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })
})

/**
 * **D48 — opening a hero's row.**
 *
 * The row is a summary; this is the page behind it. Two things the screen must not do: fetch
 * forty-four heroes' match lists to render a table, and state a round number the record cannot
 * give it.
 */
describe('opening a hero', () => {
  const HISTORY = {
    characterId: 'thor',
    matchups: [
      { characterId: 'moon-elf', wins: 3, losses: 0, draws: 1 },
      { characterId: 'ninja', wins: 1, losses: 1, draws: 0 },
      { characterId: 'krampus', wins: 0, losses: 1, draws: 0 },
    ],
    appearances: [
      {
        roomCode: 'ABC123',
        playedAt: Date.now() - 86400000,
        format: 'Bo3',
        draftCount: 4,
        seat: 'A' as const,
        round: 1,
        outcome: 'WIN' as const,
        player: { id: 'p-tom', name: 'Tom' },
        opponent: { id: 'p-alex', name: 'Alex', hero: 'moon-elf' },
      },
      {
        roomCode: 'OLD001',
        playedAt: Date.now() - 86400000 * 40,
        format: 'Bo1',
        draftCount: 3,
        seat: 'B' as const,
        round: null,
        outcome: 'LOSS' as const,
        player: { id: 'p-alex', name: 'Alex' },
        opponent: { id: 'p-tom', name: 'Tom', hero: null },
      },
    ],
  }

  /*
   * Keyed on `/api/hero?` rather than `/api/hero`: the override matcher is a substring test and
   * the board's own endpoint is `/api/heroes`, which the shorter key also matches — serving this
   * history to the board and leaving the page with nothing to render.
   */
  const withHistory = () => serveBoards({ '/api/hero?': HISTORY })

  const openThor = async () => {
    await waitFor(() => expect(document.querySelectorAll('.hrow__name').length).toBeGreaterThan(1))
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[1]!)
  }

  it('does not fetch a hero’s games until its row is opened', async () => {
    const fetchMock = withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.hrow__name')).toBeTruthy())

    // Forty-four heroes' worth of match lists is a download, not a table.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/hero?'))).toBe(false)
    await openThor()
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/hero?id=thor'))).toBe(
        true,
      ),
    )
  })

  it('lists each round with who played it, the format and the opponent', async () => {
    withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()

    const rounds = await screen.findAllByRole('listitem')
    const played = rounds.filter((li) => li.className.includes('hgame'))
    expect(played).toHaveLength(2)
    // A hero is only ever as good as somebody was with it, so the names are on the line.
    expect(played[0]!.textContent).toContain('Tom')
    expect(played[0]!.textContent).toContain('Alex')
    expect(played[0]!.textContent).toContain('Bo3')
    expect(played[0]!.textContent).toContain('draft 4')
    expect(played[0]!.textContent).toContain('R2')
    expect(played[0]!.textContent).toContain('Moon Elf')
    expect(played[0]!.textContent).toContain('Won')
  })

  it('says plainly which round it cannot name, rather than picking one', async () => {
    withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()

    // A round deduced from a sweep knows the result and not the order — see D47. A plausible "R1"
    // would be the only invented thing on this page and the hardest to catch.
    const old = (await screen.findAllByRole('listitem')).find((li) =>
      li.textContent?.includes('Lost'),
    )!
    expect(old.textContent).toContain('round unknown')
    expect(old.textContent).toContain('opponent unknown')
  })

  it('shows every opponent, level records included', async () => {
    withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()

    const ups = await waitFor(() => {
      const found = [...document.querySelectorAll('.hup')]
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    // The row shows three a side and drops the level ones; this is the list they belong in.
    expect(ups.map((u) => u.textContent)).toEqual(['Moon Elf3–0–1', 'Ninja1–1', 'Krampus0–1'])
  })

  it('closes again, and opening another closes the first', async () => {
    withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()
    await waitFor(() => expect(document.querySelector('.herodetail')).toBeTruthy())

    // One at a time: a board with six rows expanded is a page you scroll past rather than a table
    // you compare across.
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0]!)
    await waitFor(() => expect(document.querySelectorAll('.herodetail')).toHaveLength(1))
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1)
  })

  it('does not disturb the rows the board is counted from', async () => {
    withHistory()
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()
    await waitFor(() => expect(document.querySelector('.herodetail')).toBeTruthy())

    // The detail row deliberately does not wear `table__row`: every reader of this table selects
    // on that class to count heroes, and an opened board must not report one hero too many.
    expect(document.querySelectorAll('.table__row:not(.table__row--head)')).toHaveLength(4)
  })

  it('says so when a hero’s games cannot be loaded', async () => {
    serveBoards({ '/api/hero?': null })
    render(<Leaderboard board="heroes" onBack={vi.fn()} />)
    await openThor()

    // The board around it still stands: one failed panel is not a failed page.
    expect(await screen.findByText(/Could not load/)).toBeTruthy()
    expect(document.querySelectorAll('.table__row:not(.table__row--head)')).toHaveLength(4)
  })
})
