import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import type { PlayerView } from '@banpick/types'

import { PhaseTitle, titleFor } from '../src/components/PhaseTitle.js'
import { Stage } from '../src/components/Stage.js'
import { view } from './fixtures.js'

/**
 * The beats between the states.
 *
 * The server resolves several modules into one frame — committing a draft fires the reveal, which
 * opens round one, which offers the roll — so without punctuation the board jumps from "choose
 * four characters" to "round one, ban something" between two renders with nothing marking that
 * anything happened.
 */

beforeEach(() => {
  cleanup()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const at = (over: Partial<PlayerView>) => view(over)

describe('the phase card names what you just walked into', () => {
  it('reads the phase from its type, never from a module id', () => {
    // Module ids are mode config (`ban`, `draft`, `rounds.0.ban`). A client that keyed on them
    // would know something about the mode file, which is the coupling D18 exists to prevent.
    expect(
      titleFor(
        at({
          phase: { moduleId: 'anything-at-all', type: 'BAN', roundIndex: 1, awaiting: ['A'] },
        }),
      ),
    ).toBe('Round 2 — ban')
  })

  it('tells the ban phase from the draft by what the commit asks for', () => {
    const commitPhase = (picks: unknown) =>
      at({
        phase: { moduleId: 'x', type: 'SIMULTANEOUS_COMMIT', roundIndex: null, awaiting: ['A'] },
        legalActions: [
          { type: 'COMMIT', moduleId: 'x', picks, metaBan: null },
        ] as PlayerView['legalActions'],
      })

    expect(titleFor(commitPhase(null))).toBe('Ban a character')
    expect(titleFor(commitPhase({ count: 4, poolBySlot: [] }))).toBe('Draft your roster')
  })

  it('says nothing once the match is over', () => {
    expect(titleFor(at({ status: 'COMPLETE' }))).toBeNull()
  })

  it('shows on entering a phase and clears itself', () => {
    vi.useFakeTimers()
    const first = at({
      phase: { moduleId: 'x', type: 'BAN', roundIndex: 0, awaiting: ['A'] },
    })
    const { rerender } = render(<PhaseTitle view={first} />)
    // Nothing on mount: you did not just walk into this, you were already here.
    expect(document.querySelector('.phasetitle')).toBeNull()

    rerender(
      <PhaseTitle
        view={at({ phase: { moduleId: 'y', type: 'SELECT', roundIndex: 0, awaiting: ['A'] } })}
      />,
    )
    expect(screen.getByText('Round 1 — choose your fighter')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(1500))
    expect(document.querySelector('.phasetitle')).toBeNull()
  })

  it('stays out of the way under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }))
    const { rerender } = render(
      <PhaseTitle
        view={at({ phase: { moduleId: 'x', type: 'BAN', roundIndex: 0, awaiting: ['A'] } })}
      />,
    )
    rerender(
      <PhaseTitle
        view={at({ phase: { moduleId: 'y', type: 'SELECT', roundIndex: 0, awaiting: ['A'] } })}
      />,
    )
    expect(document.querySelector('.phasetitle')).toBeNull()
  })
})

describe('the score moves when it changes', () => {
  const scored = (mine: number) =>
    view({
      you: { seat: 'A', score: mine, hasCommitted: true, slotCount: 1, slots: [] },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 1, slots: [] },
    })

  const board = (v: PlayerView) => (
    <Stage view={v} expected={1} mine={{ filled: 0 }} theirs={{ filled: 0 }} />
  )

  it('formats a half point rather than rounding it away', () => {
    // D21 scores a tied round 0.5 each, so halves are real and "1" would be a lie.
    render(board(scored(1.5)))
    expect(screen.getByText('1.5')).toBeTruthy()
  })

  it('flashes only when the number actually changes', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(board(scored(0)))
    expect(container.querySelector('.side__score--bumped')).toBeNull()

    rerender(board(scored(1)))
    expect(container.querySelector('.side__score--bumped')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(700))
    expect(container.querySelector('.side__score--bumped')).toBeNull()
  })
})

/**
 * The end of the match, as a sequence rather than a panel.
 *
 * The board tells it first — the losing side recedes, the winner's cards rise and take the gold —
 * and the result resolves after that has played. Announcing the winner on the same frame the
 * cards start moving would answer the question the sequence is asking.
 */
describe('the victory sequence is ordered', () => {
  const CSS_TEXT = readFileSync('apps/web/src/styles.css', 'utf8')

  it('lets the loser recede before the winner rises, and the result speak last', () => {
    // Read from the stylesheet because happy-dom runs no cascade — and because the ordering is
    // the assertion, not the pixels.
    // Anchored to the line start: the reduced-motion block declares the same selectors indented,
    // and an unanchored match finds that one instead.
    const loser = /^\.side--lost \.cell \{[^}]*\}/m.exec(CSS_TEXT)![0]
    expect(loser).toContain('recede')

    const winner = /^\.side--won \.cell \{[^}]*\}/m.exec(CSS_TEXT)![0]
    expect(winner).toContain('rise')
    // The winner waits for the loser; the outcome waits for the winner.
    const riseDelay = Number(/rise[^,]*?(\d+)ms both/.exec(winner)![1])
    const outcome = /^\.outcome \{[^}]*\}/m.exec(CSS_TEXT)![0]
    const outcomeDelay = Number(/(\d+)ms both/.exec(outcome)![1])

    expect(riseDelay).toBeGreaterThan(0)
    expect(outcomeDelay).toBeGreaterThan(riseDelay)
  })

  it('plays a cue that matches the result, from the seat that is reading it', () => {
    const cues: string[] = []
    vi.stubGlobal('AudioContext', undefined)
    // `play` is a no-op without audio; what is asserted here is that Outcome asks for the right
    // one, which is the part that can be wrong.
    const src = readFileSync('apps/web/src/components/RoundStrip.tsx', 'utf8')
    expect(src).toContain("view.outcome === 'DRAW' ? 'reveal'")
    expect(src).toContain("view.outcome === view.seat ? 'win' : 'lose'")
    expect(cues).toEqual([])
  })
})
