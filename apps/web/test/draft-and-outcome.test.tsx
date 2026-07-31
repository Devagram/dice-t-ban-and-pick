import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Character } from '@banpick/types'

import { CharacterPicker } from '../src/components/CharacterPicker.js'
import { DraftPanel } from '../src/components/DraftPanel.js'
import { Outcome, RoundStrip } from '../src/components/RoundStrip.js'
import { RulesetCard } from '../src/components/RulesetCard.js'
import { getFavourites, getRecents } from '../src/favourites.js'
import { COMMIT_ACTION, ROSTER, RULESET, view } from './fixtures.js'

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

/** The ~75-character scale O6 says the UI has to survive. */
const BIG_ROSTER: Character[] = Array.from({ length: 75 }, (_, i) => ({
  id: `char-${i}`,
  name: `Character ${i}`,
  blurb: i % 3 === 0 ? 'Absorbs pressure.' : 'Rewards risk.',
  status: 'ACTIVE' as const,
}))

/**
 * **O6 — "Text search, favourites, and recents are requirements, not polish."**
 *
 * There is a second reason beyond findability, and it is the one that decides whether
 * `bring-ban1` works at all: at 75 characters a meta ban hits ~5.3% of the time under uniform
 * drafting. The mode survives only because people draft favourites. Making favourites easy to
 * reach is what turns "did they bring this?" into "what do they always play?".
 */
describe('drafting at ~75 characters', () => {
  it('searches by name', () => {
    render(
      <CharacterPicker
        label="Your draft"
        pool={BIG_ROSTER.map((c) => c.id)}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Search characters'), {
      target: { value: 'Character 7' },
    })
    // 7, 70..79 — a real narrowing from 75, which is the whole point. Counted from the grid
    // tiles rather than by matching button text: a tile now contains a portrait as well as a
    // name, so its textContent is not the name alone.
    const shown = screen.getAllByRole('listitem')
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(BIG_ROSTER.length)
  })

  it('searches the blurb too, because people remember what someone does', () => {
    render(
      <CharacterPicker
        label="Your draft"
        pool={BIG_ROSTER.map((c) => c.id)}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Search characters'), {
      target: { value: 'absorbs' },
    })
    expect(screen.getByText('Character 0')).toBeTruthy()
    expect(screen.queryByText('Character 1')).toBeNull()
  })

  it('says so plainly when a search matches nothing', () => {
    render(
      <CharacterPicker
        label="Your draft"
        pool={BIG_ROSTER.map((c) => c.id)}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText('Search characters'), { target: { value: 'zzz' } })
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
  })

  it('remembers favourites and floats them to the top', () => {
    const { rerender } = render(
      <CharacterPicker
        label="Your draft"
        pool={['char-9', 'char-1']}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText('Add Character 9 to favourites'))
    expect(getFavourites()).toEqual(['char-9'])

    rerender(
      <CharacterPicker
        label="Your draft"
        pool={['char-9', 'char-1']}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )

    // Scoped to the grid tiles: the filter chips are aria-pressed too, and an unscoped role
    // query would rank "★ Favourites" as the first result.
    const listed = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.tile__name')?.textContent ?? '')
    expect(listed).toEqual(['Character 9', 'Character 1'])
  })

  it('does not offer the favourites or recents filters before there are any', () => {
    render(
      <CharacterPicker
        label="Your draft"
        pool={BIG_ROSTER.map((c) => c.id)}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )
    expect((screen.getByRole('button', { name: /Favourites/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('button', { name: /Recent/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('shows only what the server put in the pool', () => {
    // The pool arrives already differenced against global bans, meta bans, and D12 (§6). A
    // character outside it is *absent*, not disabled — the client never had it to show.
    render(
      <CharacterPicker
        label="Your draft"
        pool={['char-0', 'char-1']}
        roster={BIG_ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('Character 0')).toBeTruthy()
    expect(screen.queryByText('Character 2')).toBeNull()
  })
})

describe('the hidden commit', () => {
  it('walks the per-slot pools and seals only when complete', () => {
    const onAct = vi.fn()
    render(<DraftPanel view={view()} commit={COMMIT_ACTION} onAct={onAct} />)

    // §12 — the seal is the point, so there is no commit button until there is something to
    // seal, and the warning arrives with it.
    expect(screen.queryByRole('button', { name: /Seal and commit/ })).toBeNull()

    for (const name of ['The Anvil', 'The Cartographer', 'The Duelist', 'The Gambler']) {
      fireEvent.click(screen.getByText(name))
    }
    // Meta ban next — bring-ban1's commit carries both.
    fireEvent.click(screen.getByText('The Herald'))

    const commit = screen.getByRole('button', { name: /Seal and commit/ })
    expect(screen.getByText(/cannot be changed or taken back/)).toBeTruthy()

    fireEvent.click(commit)
    expect(onAct).toHaveBeenCalledWith({
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
      metaBan: 'herald',
    })
  })

  it('records what was drafted as recents, for the next match', () => {
    render(<DraftPanel view={view()} commit={COMMIT_ACTION} onAct={vi.fn()} />)
    for (const name of ['The Anvil', 'The Cartographer', 'The Duelist', 'The Gambler']) {
      fireEvent.click(screen.getByText(name))
    }
    fireEvent.click(screen.getByText('The Herald'))
    fireEvent.click(screen.getByRole('button', { name: /Seal and commit/ }))

    expect(getRecents()).toEqual(['anvil', 'cartographer', 'duelist', 'gambler'])
  })

  it('lets a pick be taken back before the seal, driven from the board', () => {
    // Taking a pick back used to live in a "Slot 1 / Slot 2 / …" strip under the picker, which
    // redrew the same four boxes the board was already showing. The strip is gone; the board
    // raises the request and the panel applies it. See `stage-remove.test.tsx` for the click.
    const onDraftChange = vi.fn()
    const { rerender } = render(
      <DraftPanel
        view={view()}
        commit={COMMIT_ACTION}
        onAct={vi.fn()}
        onDraftChange={onDraftChange}
        removeRequest={{ id: '', n: 0 }}
      />,
    )
    fireEvent.click(screen.getByText('The Anvil'))
    expect(onDraftChange).toHaveBeenLastCalledWith(['anvil'], null)

    rerender(
      <DraftPanel
        view={view()}
        commit={COMMIT_ACTION}
        onAct={vi.fn()}
        onDraftChange={onDraftChange}
        removeRequest={{ id: 'anvil', n: 1 }}
      />,
    )
    expect(onDraftChange).toHaveBeenLastCalledWith([], null)
  })
})

/**
 * D21 — "a 1.5–1.5 draw is a legal terminal state: the match is a draw", and the delivery plan
 * asks for it designed rather than bolted on. At a 5% per-round tie rate roughly 7% of matches
 * end this way.
 */
describe('the draw is a designed outcome', () => {
  it('names it, rather than showing an absent winner', () => {
    render(
      <Outcome
        view={view({
          status: 'COMPLETE',
          outcome: 'DRAW',
          you: { seat: 'A', score: 1.5, hasCommitted: true, slotCount: 4 },
          opponent: { seat: 'B', score: 1.5, hasCommitted: true, slotCount: 4 },
        })}
      />,
    )
    expect(screen.getByText('Drawn match')).toBeTruthy()
    expect(screen.getByText(/one and a half each/)).toBeTruthy()
    // Halves are ordinary under HALF_POINT, so they render as halves.
    expect(screen.getAllByText('1.5')).toHaveLength(2)
  })

  it('renders a win and a loss from the reading seat', () => {
    const { rerender } = render(<Outcome view={view({ status: 'COMPLETE', outcome: 'A' })} />)
    expect(screen.getByText('You win the match')).toBeTruthy()

    rerender(<Outcome view={view({ seat: 'B', status: 'COMPLETE', outcome: 'A' })} />)
    expect(screen.getByText('They win the match')).toBeTruthy()
  })

  it('shows nothing while the match is live', () => {
    const { container } = render(<Outcome view={view()} />)
    expect(container.innerHTML).toBe('')
  })

  it('marks a tied round as tied in the round strip', () => {
    const v = view()
    v.rounds[0]!.result = 'TIE'
    render(<RoundStrip view={v} />)
    expect(screen.getByText('Tied')).toBeTruthy()
  })
})

/** §12.3 — "seating is the consent", so the render must be complete, not a summary. */
describe('the ruleset a joiner consents to', () => {
  it('spells out the parameter value rather than implying it', () => {
    render(
      <RulesetCard
        modeLabel="Standard Bo3 — draft 3"
        ruleset={{ ...RULESET, parameters: { draftCount: 3 } }}
        globalBannedCharacters={[]}
        rosterSize={10}
      />,
    )
    // "A host quietly switching from 4 picks to 3 is exactly the kind of change the joiner must
    // see" — so the number is on screen, not just inside the mode label.
    expect(screen.getByText('Characters drafted')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('lists every global ban by name, not as a count', () => {
    render(
      <RulesetCard
        modeLabel="Standard Bo3 — draft 4"
        ruleset={{ ...RULESET, globalBanned: ['anvil', 'oracle'] }}
        globalBannedCharacters={[ROSTER[0]!, ROSTER[6]!]}
        rosterSize={10}
      />,
    )
    // "2 characters banned" is not something a person can agree to.
    expect(screen.getByText('The Anvil')).toBeTruthy()
    expect(screen.getByText('The Oracle')).toBeTruthy()
  })

  it('states the tie rule, because a draw is reachable', () => {
    render(
      <RulesetCard
        modeLabel="Standard Bo3 — draft 4"
        ruleset={RULESET}
        globalBannedCharacters={[]}
        rosterSize={10}
      />,
    )
    expect(screen.getByText('Half a point each')).toBeTruthy()
    expect(screen.getByText(/is a draw/)).toBeTruthy()
  })
})
