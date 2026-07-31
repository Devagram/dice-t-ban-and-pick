import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

import { Stage } from '../src/components/Stage.js'
import { view } from './fixtures.js'

/**
 * Taking a pick back, from the board.
 *
 * It used to live in a "Slot 1 / Slot 2 / …" strip under the picker — four boxes restating the
 * four the board was already drawing, with the only removal affordance stranded in the copy. The
 * strip is gone and the board carries it, which is also where a fighting game puts it: you click
 * the fighter you chose.
 */

const drafting = () =>
  view({
    you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
    opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
  })

beforeEach(() => {
  cleanup()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})

describe('your own uncommitted picks come back off the board', () => {
  it('raises the character you clicked', () => {
    const onRemoveOwn = vi.fn()
    render(
      <Stage
        view={drafting()}
        expected={4}
        mine={{ filled: 2, picks: ['anvil', 'cartographer'] }}
        theirs={{ filled: 0 }}
        onRemoveOwn={onRemoveOwn}
      />,
    )

    fireEvent.click(screen.getByLabelText('Remove The Cartographer'))
    expect(onRemoveOwn).toHaveBeenCalledWith('cartographer')
  })

  it('offers nothing to remove on their side', () => {
    // Their cells are face down and not yours to touch. A count is all that reaches this side.
    const onRemoveOwn = vi.fn()
    const { container } = render(
      <Stage
        view={drafting()}
        expected={4}
        mine={{ filled: 0 }}
        theirs={{ filled: 3 }}
        onRemoveOwn={onRemoveOwn}
      />,
    )
    expect(container.querySelectorAll('.side--opponent .cell--removable')).toHaveLength(0)
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
  })

  it('offers nothing once the draft is sealed', () => {
    // §12 — a committed-but-unrevealed action cannot be withdrawn, so there must be no control
    // suggesting otherwise.
    const sealed = view({
      you: { seat: 'A', score: 0, hasCommitted: true, slotCount: 4 },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 4 },
    })
    render(
      <Stage
        view={sealed}
        expected={4}
        mine={{ filled: 4, picks: ['anvil', 'cartographer'] }}
        theirs={{ filled: 4 }}
        onRemoveOwn={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
  })

  it('offers nothing once the picks are revealed', () => {
    const revealed = view({
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 1,
        slots: [{ index: 0, characterId: 'anvil', consumed: false, bannedInRound: null }],
      },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 1 },
    })
    render(
      <Stage
        view={revealed}
        expected={1}
        mine={{ filled: 1 }}
        theirs={{ filled: 1 }}
        onRemoveOwn={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
  })
})

/**
 * The roster grid's space budget.
 *
 * Two separate savings, both asserted on the stylesheet because happy-dom does no layout: the art
 * is cropped to the head, and every name is held to one line.
 */
const CSS = readFileSync('apps/web/src/styles.css', 'utf8')
const ROSTER = JSON.parse(readFileSync('roster/roster.json', 'utf8')) as {
  characters: { id: string; name: string }[]
}

describe('the roster is dense enough not to need its own scrollbar', () => {
  it('crops the tile art to the top of the card', () => {
    // At 92px wide the body is a smear and the face is what anyone recognises. Cropping roughly
    // halves the height of every row.
    expect(CSS).toMatch(/\.portrait--head \{[^}]*aspect-ratio:\s*199 \/ 150/)
    expect(CSS).toMatch(/\.portrait--head \.portrait__img \{[^}]*object-position:\s*top center/)
  })

  it('holds every tile name to one line', () => {
    expect(CSS).toMatch(/\.tile__name \{[^}]*white-space:\s*nowrap/)
    expect(CSS).toMatch(/\.tile__name \{[^}]*text-overflow:\s*ellipsis/)
  })

  it('cut the names that were long for no reason', () => {
    const byId = new Map(ROSTER.characters.map((c) => [c.id, c.name]))
    // The parenthetical was most of the string and none of the meaning.
    expect(byId.get('miles-morales')).toBe('Miles Morales')
    expect(byId.get('doctor-strange')).toBe('Dr. Strange')
    expect(byId.get('captain-marvel')).toBe('Capt. Marvel')
    for (const name of byId.values()) expect(name).not.toContain('(')
  })

  it('leaves every name short enough to read in a tile', () => {
    // Truncation is the guarantee, not the plan — a name that has to ellipsise is one nobody can
    // identify at a glance. 17 is what fits at 92px and 0.62rem.
    const tooLong = ROSTER.characters.filter((c) => c.name.length > 17)
    expect(tooLong.map((c) => `${c.id}: ${c.name}`)).toEqual([])
  })
})
