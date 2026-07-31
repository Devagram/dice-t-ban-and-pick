import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PlayerView, Slot } from '@banpick/types'

import { Stage } from '../src/components/Stage.js'
import { view } from './fixtures.js'

/**
 * The round, told by where the cards are.
 *
 * Position carries meaning on this board: what you are playing sits against the centre line, what
 * is still available flanks it, and what is out of play drifts to the edge. These read the
 * `transform` each cell is given, which is the whole layout — cells are absolutely positioned and
 * moved, so that one string is the entire statement of where a card is and how big it is.
 */

const slot = (index: number, characterId: string, over: Partial<Slot> = {}): Slot => ({
  index: index as Slot['index'],
  characterId,
  consumed: false,
  bannedInRound: null,
  ...over,
})

const FOUR = [slot(0, 'anvil'), slot(1, 'cartographer'), slot(2, 'duelist'), slot(3, 'gambler')]

const played = (slots: Slot[], over: Partial<PlayerView> = {}): PlayerView =>
  view({
    phase: { moduleId: 'rounds.0.select', type: 'SELECT', roundIndex: 0, awaiting: ['A'] },
    you: { seat: 'A', score: 0, hasCommitted: true, slotCount: slots.length, slots },
    opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: slots.length, slots },
    ...over,
  })

/** The `translateX(...)` px value on the cell holding a given character, from its own side. */
const offsetOf = (name: string, side: 'own' | 'opponent' = 'own'): number => {
  const root = document.querySelector(`.side--${side}`)!
  const li = [...root.querySelectorAll('.cell-slot')].find((el) =>
    el.textContent?.includes(name),
  ) as HTMLElement
  const match = /translateX\((-?[\d.]+)px\)/.exec(li.style.transform)
  return Math.abs(Number(match![1]))
}

const scaleOf = (name: string): number => {
  const li = [...document.querySelectorAll('.side--own .cell-slot')].find((el) =>
    el.textContent?.includes(name),
  ) as HTMLElement
  return Number(/scale\(([\d.]+)\)/.exec(li.style.transform)![1])
}

beforeEach(() => {
  cleanup()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})

describe('the character you are playing takes centre stage', () => {
  it('moves to the slot against the centre line and grows by half', () => {
    render(
      <Stage
        view={played(FOUR, {
          rounds: [
            {
              index: 0,
              privilegeHolder: 'A',
              turnOrderHolder: null,
              roll: null,
              ban: null,
              // A is playing slot 2 — third in draft order, and it should not stay third here.
              selection: { A: 2 as Slot['index'] },
              selectionCommitted: { A: true, B: false },
              playOrder: null,
              result: null,
            },
          ],
        })}
        expected={4}
        mine={{ filled: 4 }}
        theirs={{ filled: 4 }}
      />,
    )

    expect(offsetOf('The Duelist')).toBe(0) // hard against the "vs"
    expect(scaleOf('The Duelist')).toBe(1.5)
    // Everything else keeps draft order behind it.
    expect(offsetOf('The Anvil')).toBeGreaterThan(0)
    expect(scaleOf('The Anvil')).toBe(1)
  })
})

describe('what is out of play moves away from the centre', () => {
  it('sends a spent character furthest out and greys it', () => {
    render(
      <Stage
        view={played([
          slot(0, 'anvil', { consumed: true }),
          slot(1, 'cartographer'),
          slot(2, 'duelist'),
        ])}
        expected={3}
        mine={{ filled: 3 }}
        theirs={{ filled: 3 }}
      />,
    )

    // Slot 0 would sit nearest the centre by draft order; consumed sends it to the far edge.
    expect(offsetOf('The Anvil')).toBeGreaterThan(offsetOf('The Cartographer'))
    expect(offsetOf('The Anvil')).toBeGreaterThan(offsetOf('The Duelist'))
    expect(document.querySelector('.side--own .cell--spent')).toBeTruthy()
  })

  it('stamps a round ban in words, not just in grey', () => {
    // D3 — a round ban is temporary and the character returns next round. Grey alone reads the
    // same as "already played", which is permanent.
    render(
      <Stage
        view={played([slot(0, 'anvil', { bannedInRound: 0 }), slot(1, 'cartographer')])}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )

    expect(screen.getAllByText('Round banned').length).toBeGreaterThan(0)
    expect(offsetOf('The Anvil')).toBeGreaterThan(offsetOf('The Cartographer'))
  })

  it('ranks a spent character further out than a merely banned one', () => {
    render(
      <Stage
        view={played([
          slot(0, 'anvil', { consumed: true }),
          slot(1, 'cartographer', { bannedInRound: 0 }),
          slot(2, 'duelist'),
        ])}
        expected={3}
        mine={{ filled: 3 }}
        theirs={{ filled: 3 }}
      />,
    )
    // Gone for good sits beyond gone for now, which sits beyond still available.
    expect(offsetOf('The Anvil')).toBeGreaterThan(offsetOf('The Cartographer'))
    expect(offsetOf('The Cartographer')).toBeGreaterThan(offsetOf('The Duelist'))
  })
})

describe('the reveal runs outside-in, alternating sides', () => {
  it('flips the outermost pair first and the centre pair last', () => {
    render(
      <Stage
        view={played(FOUR)}
        expected={4}
        mine={{ filled: 4 }}
        theirs={{ filled: 4 }}
        revealing
      />,
    )

    const delays = (side: 'own' | 'opponent') =>
      [...document.querySelectorAll(`.side--${side} .cell-slot`)]
        .map((el) => (el as HTMLElement).style.getPropertyValue('--flip-delay'))
        .map((d) => Number(d.replace('ms', '')))
        .sort((a, b) => a - b)

    // Four cells a side, alternating: 0/150 for the outermost pair through 900/1050 for the pair
    // beside the "vs" — so the last card to turn is the one the eye is already on.
    expect(delays('own')).toEqual([0, 300, 600, 900])
    expect(delays('opponent')).toEqual([150, 450, 750, 1050])
  })

  it('gives the outermost card the shortest delay on each side', () => {
    render(
      <Stage
        view={played(FOUR)}
        expected={4}
        mine={{ filled: 4 }}
        theirs={{ filled: 4 }}
        revealing
      />,
    )
    const own = [...document.querySelectorAll('.side--own .cell-slot')] as HTMLElement[]
    const byOffset = own.sort(
      (a, b) =>
        Math.abs(Number(/translateX\((-?[\d.]+)px\)/.exec(b.style.transform)![1])) -
        Math.abs(Number(/translateX\((-?[\d.]+)px\)/.exec(a.style.transform)![1])),
    )
    const delays = byOffset.map((el) =>
      Number(el.style.getPropertyValue('--flip-delay').replace('ms', '')),
    )
    // Sorted furthest-out first, the delays only increase: outside in.
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
  })
})

/**
 * The ban bar's lifetime.
 *
 * It exists to inform a decision — the whole reason the ban moved in front of the draft is that
 * you choose knowing what is gone. Once both rosters are locked it cannot change anything, and
 * the character it names is visibly absent from the boards under it.
 */
describe('the ban bar retires once both rosters are locked', () => {
  const withBans = (locked: boolean): PlayerView =>
    view({
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: locked,
        slotCount: locked ? 2 : 0,
        metaBanPlaced: 'duelist',
      },
      opponent: {
        seat: 'B',
        score: 0,
        hasCommitted: locked,
        slotCount: locked ? 2 : 0,
        metaBanPlaced: 'gambler',
      },
    })

  it('shows both bans while there is still drafting to do', () => {
    render(
      <Stage view={withBans(false)} expected={4} mine={{ filled: 0 }} theirs={{ filled: 0 }} />,
    )
    expect(screen.getByText('You banned')).toBeTruthy()
    expect(screen.getByText('They banned')).toBeTruthy()
    expect(screen.getByText('The Duelist')).toBeTruthy()
  })

  it('disappears once both sides have committed', () => {
    render(<Stage view={withBans(true)} expected={4} mine={{ filled: 4 }} theirs={{ filled: 4 }} />)
    expect(screen.queryByText('You banned')).toBeNull()
    expect(screen.queryByText('They banned')).toBeNull()
  })

  it('stays while only one side has locked in', () => {
    // Still live information: the seat that has not drafted can act on it.
    const half = view({
      you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0, metaBanPlaced: 'duelist' },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 4, metaBanPlaced: 'gambler' },
    })
    render(<Stage view={half} expected={4} mine={{ filled: 1 }} theirs={{ filled: 4 }} />)
    expect(screen.getByText('They banned')).toBeTruthy()
  })
})
