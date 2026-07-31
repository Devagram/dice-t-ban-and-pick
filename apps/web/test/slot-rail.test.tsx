import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SlotRail } from '../src/components/SlotRail.js'
import { ROSTER } from './fixtures.js'
import type { SeatView, Slot } from '@banpick/types'

/**
 * The draft, watched from both sides.
 *
 * The rail is on screen for the whole match now, including during the draft. Three distinct
 * sources feed it and the whole point of these tests is that it never confuses them:
 *
 *   - `expected` — `draftCount`, public and authoritative, so the boxes exist from the start
 *   - `pending`  — the opponent's **self-reported** count, which the server cannot verify
 *   - `view.slots` — the real thing, present only once §7 says you may see it
 */

beforeEach(() => {
  cleanup()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})
afterEach(() => vi.unstubAllGlobals())

const sealedSeat = (over: Partial<SeatView> = {}): SeatView => ({
  seat: 'B',
  score: 0,
  hasCommitted: false,
  slotCount: 0,
  ...over,
})

const slot = (index: number, characterId: string, over: Partial<Slot> = {}): Slot => ({
  index: index as Slot['index'],
  characterId,
  consumed: false,
  bannedInRound: null,
  ...over,
})

const boxes = () => Array.from(document.querySelectorAll('.slot'))
const classesOf = () => boxes().map((b) => b.className)

describe('empty slots exist before anyone commits', () => {
  it('draws one box per drafted slot even though slotCount is still zero', () => {
    // `slotCount` is derived from committed slots, so it is 0 for the whole draft. Sizing the
    // rail from it gave an empty column that snapped to four boxes at once — the thing that made
    // the draft feel like nothing was happening.
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
      />,
    )

    expect(boxes()).toHaveLength(4)
    expect(screen.getAllByText('Empty')).toHaveLength(4)
  })

  it('fills them one at a time as the opponent reports progress', () => {
    const { rerender } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 0 }}
      />,
    )
    expect(classesOf().filter((c) => c.includes('slot--choosing'))).toHaveLength(0)

    for (const filled of [1, 2, 3, 4]) {
      rerender(
        <SlotRail
          title="Theirs"
          view={sealedSeat()}
          roster={ROSTER}
          currentRound={null}
          expected={4}
          pending={{ filled }}
        />,
      )
      expect(classesOf().filter((c) => c.includes('slot--choosing'))).toHaveLength(filled)
      expect(boxes()).toHaveLength(4) // the rail never grows
    }
  })

  it('draws boxes when slots is present but empty, not just when it is absent', () => {
    // The engine starts slots as a **public empty slice**: visible, holding nothing. Only a
    // commit makes it absent. Treating presence as "revealed" sent the rail down the revealed
    // path with an empty array and drew nothing at all for the whole draft — the exact blank
    // screen this component was built to remove. `apps/worker/test/rail-sizing.test.ts` pins the
    // server side of the same fact.
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ slots: [] })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 2 }}
      />,
    )

    expect(boxes()).toHaveLength(4)
    expect(classesOf().filter((c) => c.includes('slot--choosing'))).toHaveLength(2)
  })

  it('shows the running count beside the title', () => {
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 2 }}
      />,
    )
    expect(screen.getByText('2 of 4')).toBeTruthy()
  })
})

describe('a reported pick is not a committed one', () => {
  it('draws choosing and sealed differently', () => {
    // The honesty requirement. A pending count is the opponent's client talking; a commit is the
    // server. Rendering them identically would present a guess as a fact.
    const { rerender } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 4 }}
      />,
    )
    expect(classesOf().every((c) => c.includes('slot--choosing'))).toBe(true)
    expect(screen.getAllByText('Chosen')).toHaveLength(4)

    // Now the commit actually lands.
    rerender(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 4 })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 4 }}
      />,
    )
    expect(classesOf().every((c) => c.includes('slot--sealed'))).toBe(true)
    expect(screen.getAllByText('Sealed')).toHaveLength(4)
  })

  it('treats a committed seat as full even if progress said otherwise', () => {
    // A stale or lying count must not make a committed rail look half-empty: `hasCommitted` is
    // server-confirmed and wins.
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 4 })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 1 }}
      />,
    )
    expect(screen.getAllByText('Sealed')).toHaveLength(4)
  })

  it('never names a character it was not given', () => {
    // §7: during the seal there are no ids to leak, and the rail must not invent one.
    const { container } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 4 })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 4 }}
      />,
    )
    for (const character of ROSTER) {
      expect(container.textContent).not.toContain(character.name)
    }
  })
})

describe('your own picks are yours to see', () => {
  it('shows them face up while the opponent sees only a count', () => {
    render(
      <SlotRail
        title="Yours"
        view={sealedSeat({ seat: 'A' })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 2, picks: ['anvil', 'cartographer'] }}
      />,
    )

    // Face up, because the seal is against your opponent and not against you.
    expect(screen.getByText('The Anvil')).toBeTruthy()
    expect(screen.getByText('The Cartographer')).toBeTruthy()
    expect(screen.getAllByText('Empty')).toHaveLength(2)
  })
})

describe('the meta ban sits beside the slots, not among them', () => {
  it('does not add a fifth box', () => {
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 2, ban: true }}
      />,
    )
    // Slots are the positional ban *target* (§5) — a fifth would misreport what the seat holds.
    expect(boxes()).toHaveLength(4)
    expect(screen.getByText('Meta ban')).toBeTruthy()
    expect(screen.getByText('chosen')).toBeTruthy()
  })

  it('says whose ban it is, because a ban lands on the other seat', () => {
    // D4 — the character named under "Theirs" is one of *yours* that they removed. A bare
    // "Meta ban" there reads as though one of their own is gone.
    render(
      <SlotRail
        title="Theirs"
        banLabel="They banned"
        view={sealedSeat({ hasCommitted: true, slotCount: 4, metaBanPlaced: 'anvil' })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
      />,
    )
    expect(screen.getByText('They banned')).toBeTruthy()
    expect(screen.getByText('The Anvil')).toBeTruthy()
  })

  it('shows the ban at gate one while the picks are still sealed', () => {
    // The middle state of bring-ban1: bans public, draft not. The only moment where one slice of
    // a seat is visible and another is not. `apps/worker/test/reveal-gates.test.ts` pins the wire.
    render(
      <SlotRail
        title="Theirs"
        banLabel="They banned"
        view={sealedSeat({ hasCommitted: true, slotCount: 4, metaBanPlaced: 'anvil' })}
        roster={ROSTER}
        currentRound={null}
        expected={4}
      />,
    )
    expect(screen.getAllByText('Sealed')).toHaveLength(4)
    expect(screen.getByText('The Anvil')).toBeTruthy() // the ban, and only the ban
    expect(screen.queryByText('The Cartographer')).toBeNull()
  })

  it('says nothing when no ban is in play', () => {
    render(
      <SlotRail
        title="Theirs"
        view={sealedSeat()}
        roster={ROSTER}
        currentRound={null}
        expected={4}
        pending={{ filled: 2 }}
      />,
    )
    expect(screen.queryByText('Meta ban')).toBeNull()
  })
})

describe('the reveal', () => {
  const revealed = (): SeatView => ({
    seat: 'B',
    score: 0,
    hasCommitted: true,
    slotCount: 2,
    slots: [slot(0, 'anvil'), slot(1, 'cartographer')],
  })

  it('flips the cards, staggered', () => {
    const { rerender } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 2 })}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )
    rerender(
      <SlotRail
        title="Theirs"
        view={revealed()}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )

    const flipped = boxes().filter((b) => b.className.includes('slot--flip'))
    expect(flipped).toHaveLength(2)
    // Staggered, not simultaneous: each card carries its own delay.
    const delays = flipped.map((b) => (b as HTMLElement).style.getPropertyValue('--flip-delay'))
    expect(delays).toEqual(['0ms', '150ms'])
    expect(screen.getByText('The Anvil')).toBeTruthy()
  })

  it('does not flip under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }))
    const { rerender } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 2 })}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )
    rerender(
      <SlotRail
        title="Theirs"
        view={revealed()}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )

    expect(boxes().some((b) => b.className.includes('slot--flip'))).toBe(false)
    expect(screen.getByText('The Anvil')).toBeTruthy() // still face up, just instantly
  })

  it('does not replay the flip on an unrelated re-render', () => {
    // The rail re-renders on every frame. A flip that replayed each time would be unwatchable.
    const { rerender } = render(
      <SlotRail
        title="Theirs"
        view={sealedSeat({ hasCommitted: true, slotCount: 2 })}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )
    rerender(
      <SlotRail
        title="Theirs"
        view={revealed()}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )
    expect(boxes().some((b) => b.className.includes('slot--flip'))).toBe(true)

    // Same revealed state, new frame — no second flip.
    rerender(
      <SlotRail
        title="Theirs"
        view={revealed()}
        roster={ROSTER}
        currentRound={null}
        expected={2}
      />,
    )
    const stillFlipping = boxes().filter((b) => b.className.includes('slot--flip'))
    expect(stillFlipping.length).toBe(2) // the first animation is still running, not restarted
  })
})
