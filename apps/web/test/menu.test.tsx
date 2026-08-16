import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Home } from '../src/screens/Home.js'

afterEach(cleanup)

/**
 * The front page is a menu, and the thing worth pinning is that it stays one.
 *
 * It was the host's form for most of this app's life — mode cards, parameters, forty-five
 * portraits — with the five destinations as small links above it. Every visitor met a setup
 * screen for a game they might not be starting. The regression to guard is not the styling; it is
 * a panel creeping back onto the page that has to be a choice.
 */
describe('the main menu', () => {
  it('offers the five things somebody arrives to do, in that order', () => {
    render(<Home />)
    const links = screen.getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      'Join a gameTake an open seat, or use a room code somebody sent you',
      'Host a gameChoose the mode and the rules, then send the link',
      'Host a tournamentA bracket of any size, any mode, single or double elimination',
      'LeaderboardWho is ahead, and by how much',
      'HistoryEvery match played, round by round',
    ])
    // Joining first: a room has one host and everyone else is a joiner.
    expect(links[0]!.getAttribute('href')).toBe('/lobbies')
  })

  it('sends each one to a URL that works on its own', () => {
    // Real links, not click handlers: `App.tsx` reads these paths on load, so every entry
    // survives a bookmark, a middle click, and being pasted to somebody else.
    render(<Home />)
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/lobbies',
      '/host',
      '/organizer',
      '/leaderboard',
      '/history',
    ])
  })

  it('is a menu and nothing else', () => {
    render(<Home />)
    // No form, no panel, no roster: the whole page is a choice between five destinations.
    expect(document.querySelectorAll('.panel')).toHaveLength(0)
    expect(document.querySelectorAll('input, select, textarea')).toHaveLength(0)
  })
})
