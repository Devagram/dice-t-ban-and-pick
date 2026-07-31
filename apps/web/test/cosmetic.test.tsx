import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { CharacterPicker } from '../src/components/CharacterPicker.js'
import { Portrait } from '../src/components/Portrait.js'
import { DiceRoll } from '../src/components/DiceRoll.js'
import { OpponentActivity } from '../src/components/OpponentActivity.js'
import { initialsOf, hueFor } from '../src/art.js'
import { ROSTER, view } from './fixtures.js'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  // Default to motion allowed; the reduced-motion test overrides it.
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/**
 * The character grid.
 *
 * The pool still comes from the server — the grid changes how it is *shown*, never what is
 * shown. Those assertions live in no-client-rules.test.tsx and still hold.
 */
describe('the roster reads as a grid', () => {
  it('renders one tile per pooled character, with its name', () => {
    render(
      <CharacterPicker
        label="Your draft"
        pool={ROSTER.map((c) => c.id)}
        roster={ROSTER}
        selected={[]}
        remaining={4}
        onSelect={vi.fn()}
      />,
    )

    const tiles = screen.getAllByRole('listitem')
    expect(tiles).toHaveLength(ROSTER.length)
    expect(screen.getByText('The Anvil')).toBeTruthy()
  })

  it('falls back to initials when a character has no art', () => {
    // The fixture roster is invented, so nothing in it has a portrait — which is exactly the
    // state a deployment is in after `apps/web/public/art/` is deleted.
    render(
      <CharacterPicker
        label="Your draft"
        pool={['anvil']}
        roster={ROSTER}
        selected={[]}
        remaining={1}
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('TA')).toBeTruthy() // "The Anvil"
    expect(document.querySelector('.portrait__img')).toBeNull()
  })

  it('falls back to initials when the art 404s, not just when it is unlisted', () => {
    // The half-stripped case: `apps/web/public/art/` is deleted but the generated manifest still
    // names files. Every portrait then resolves to a URL that 404s. Without the `onError` path
    // that is 45 broken-image icons — worse than no pictures at all — so the fallback has to
    // hang off the load failure and not only off a missing manifest entry.
    //
    // `barbarian` is a real manifest id, so this renders an <img> the other tests never reach;
    // the name comes from the fixture so the expected initials stay local to this file.
    render(
      <Portrait character={{ id: 'barbarian', name: 'Moon Elf', blurb: '', status: 'ACTIVE' }} />,
    )

    const img = document.querySelector('.portrait__img')
    expect(img, 'expected a real manifest entry to render an <img>').toBeTruthy()

    fireEvent.error(img!)

    expect(document.querySelector('.portrait__img')).toBeNull()
    expect(screen.getByText('ME')).toBeTruthy()
  })

  it('derives initials and a stable hue from names and ids', () => {
    expect(initialsOf('Moon Elf')).toBe('ME')
    expect(initialsOf('Thor')).toBe('TH')
    expect(initialsOf('Spider-Man (Miles Morales)')).toBe('SM')
    // Stable, because a character that changes colour between renders is not recognisable.
    expect(hueFor('barbarian')).toBe(hueFor('barbarian'))
    expect(hueFor('barbarian')).not.toBe(hueFor('moon-elf'))
  })

  it('keeps the tile clickable and the favourite separate', () => {
    const onSelect = vi.fn()
    render(
      <CharacterPicker
        label="Your draft"
        pool={['anvil']}
        roster={ROSTER}
        selected={[]}
        remaining={1}
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByLabelText('Add The Anvil to favourites'))
    expect(onSelect).not.toHaveBeenCalled() // starring is not drafting

    fireEvent.click(screen.getByText('The Anvil'))
    expect(onSelect).toHaveBeenCalledWith('anvil')
  })
})

/**
 * The dice roll.
 *
 * The result is decided server-side before any of this runs, so every test here is about the
 * *telling* — and specifically about the tie, which is the beat that used to be invisible.
 */
describe('the roll plays out', () => {
  const rollWith = (throws: { A: number; B: number }[]) => ({
    results: throws.at(-1)!,
    winner: (throws.at(-1)!.A > throws.at(-1)!.B ? 'A' : 'B') as 'A' | 'B',
    attempts: throws.length,
    throws,
  })

  it('lands on the winner and says who it is', () => {
    vi.useFakeTimers()
    const roll = rollWith([{ A: 5, B: 2 }])
    render(<DiceRoll view={view()} roll={roll} />)

    expect(screen.getByText('Rolling…')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.getByText('You win the roll')).toBeTruthy()
  })

  it('shows a tie, holds it, then rolls again — the whole point of recording throws', () => {
    vi.useFakeTimers()
    const roll = rollWith([
      { A: 4, B: 4 },
      { A: 6, B: 1 },
    ])
    render(<DiceRoll view={view()} roll={roll} />)

    // First throw lands tied, and says so rather than silently rerolling.
    act(() => void vi.advanceTimersByTime(950))
    expect(screen.getByText('Both rolled 4 — roll again')).toBeTruthy()

    // Then the decisive throw.
    act(() => void vi.advanceTimersByTime(4000))
    expect(screen.getByText('You win the roll')).toBeTruthy()
    expect(screen.getByText('2 throws — 1 tied')).toBeTruthy()
  })

  it('reads from the losing seat correctly', () => {
    vi.useFakeTimers()
    render(<DiceRoll view={view({ seat: 'B' })} roll={rollWith([{ A: 6, B: 2 }])} />)
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.getByText('They win the roll')).toBeTruthy()
  })

  it('skips straight to the result under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }))
    const onDone = vi.fn()
    render(
      <DiceRoll
        view={view()}
        roll={rollWith([
          { A: 4, B: 4 },
          { A: 3, B: 1 },
        ])}
        onDone={onDone}
      />,
    )

    // No waiting, no tumbling: someone who asked for less motion still gets the answer.
    expect(screen.getByText('You win the roll')).toBeTruthy()
    expect(onDone).toHaveBeenCalled()
  })

  it('survives a roll with no recorded throws', () => {
    // An older log, or a defensive path: fall back to the final result rather than rendering
    // nothing at all.
    vi.useFakeTimers()
    render(
      <DiceRoll
        view={view()}
        roll={{ results: { A: 5, B: 3 }, winner: 'A', attempts: 1, throws: [] }}
      />,
    )
    act(() => void vi.advanceTimersByTime(5000))
    expect(screen.getByText('You win the roll')).toBeTruthy()
  })
})

/**
 * Opponent activity — the "no indication of progress" complaint.
 *
 * Two signals with different provenance: whose turn it is comes from the server and is
 * authoritative; how far through a hidden draft they are comes from their own client and is
 * not. The component shows both without implying they are the same kind of fact.
 */
describe('you can see the opponent working', () => {
  const awaiting = (
    seats: ('A' | 'B')[],
    type: 'SIMULTANEOUS_COMMIT' | 'BAN' = 'SIMULTANEOUS_COMMIT',
  ) =>
    view({
      phase: { moduleId: 'draft', type, roundIndex: 0, awaiting: seats },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 4 },
    })

  it('names what they are doing, from the phase rather than the round', () => {
    render(<OpponentActivity view={awaiting(['B'], 'BAN')} />)
    expect(screen.getByText(/choosing which of your characters to ban/i)).toBeTruthy()
  })

  it('no longer narrates a count the board already shows', () => {
    // "They have chosen 2 of 4" and its pip bar are gone. The board fills a slot as each pick
    // lands, in the place you are already looking; a number restating that is noise.
    const { container } = render(<OpponentActivity view={awaiting(['B'])} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.textContent).not.toMatch(/\d+ of \d+/)
    expect(container.textContent).not.toMatch(/have chosen/i)
  })

  it('still says the thing the board cannot — that picks stay hidden until the reveal', () => {
    // Only while *you* are drafting too: the hint explains the seal, and there is no seal to
    // explain once your own commit is in.
    const drafting = view({
      phase: {
        moduleId: 'draft',
        type: 'SIMULTANEOUS_COMMIT',
        roundIndex: 0,
        awaiting: ['A', 'B'],
      },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 4 },
      legalActions: [
        { type: 'COMMIT', moduleId: 'draft', picks: { count: 4, poolBySlot: [] }, metaBan: null },
      ],
    })
    render(<OpponentActivity view={drafting} />)
    expect(screen.getByText(/will not see what they pick until the reveal/i)).toBeTruthy()
  })

  it('says sealed exactly when they have committed this phase and you have not', () => {
    // The real sealed moment: the server is waiting on you alone, in a commit phase.
    render(
      <OpponentActivity
        view={view({
          phase: { moduleId: 'draft', type: 'SIMULTANEOUS_COMMIT', roundIndex: 0, awaiting: ['A'] },
          opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 4 },
        })}
      />,
    )
    expect(screen.getByText(/sealed their choice/)).toBeTruthy()
  })

  it('does not claim they sealed anything while they are still choosing', () => {
    // **The bug.** This read `opponent.hasCommitted`, which is derived from slots and so means
    // "has drafted" — true forever after the draft. From then on, every round ban and every
    // selection was announced as "They have sealed their choice", over the top of the accurate
    // description of what they were actually doing.
    render(
      <OpponentActivity
        view={view({
          phase: { moduleId: 'rounds.0.ban', type: 'BAN', roundIndex: 0, awaiting: ['B'] },
          // Drafted long ago, and entirely beside the point of the phase they are in now.
          opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 4 },
        })}
      />,
    )
    expect(screen.queryByText(/sealed their choice/)).toBeNull()
    expect(screen.getByText(/choosing which of your characters to ban/i)).toBeTruthy()
  })

  it('says nothing outside a commit phase when they are not being waited on', () => {
    const { container } = render(
      <OpponentActivity
        view={view({
          phase: { moduleId: 'rounds.0.ban', type: 'BAN', roundIndex: 0, awaiting: ['A'] },
          opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 4 },
        })}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('says nothing once the match is over', () => {
    const { container } = render(<OpponentActivity view={view({ status: 'COMPLETE' })} />)
    expect(container.innerHTML).toBe('')
  })

  it('never names a character', () => {
    const { container } = render(<OpponentActivity view={awaiting(['B'])} />)
    for (const character of ROSTER) {
      expect(container.textContent).not.toContain(character.name)
    }
  })
})
