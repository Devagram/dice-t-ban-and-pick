import { describe, expect, it, beforeEach, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { PlayerView, Slot } from '@banpick/types'

import { readFileSync } from 'node:fs'

const CSS_TEXT = readFileSync('apps/web/src/styles.css', 'utf8')

import { Stage, revealDurationMs } from '../src/components/Stage.js'
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

/**
 * The character you are playing is not "spent" yet.
 *
 * Selecting consumes the slot immediately — D6 consumes it even on a tie — so the card is already
 * `consumed` while you are still playing it. Drawing that state greyed the card, struck through
 * its own name and faded it, at the exact moment it had just been promoted to centre stage.
 */
describe('the current pick stays in colour until the round moves on', () => {
  const picking = (selection: Record<string, number> | undefined, result: 'A' | 'B' | null) =>
    view({
      phase: { moduleId: 'rounds.0.report', type: 'REPORT_RESULT', roundIndex: 0, awaiting: ['A'] },
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 2,
        // Consumed the instant it was selected, which is the trap.
        slots: [slot(0, 'anvil', { consumed: true }), slot(1, 'cartographer')],
      },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: 2, slots: [] },
      rounds: [
        {
          index: 0,
          privilegeHolder: 'A',
          turnOrderHolder: null,
          roll: null,
          ban: null,
          selection: (selection ?? {}) as never,
          selectionCommitted: { A: true, B: true },
          playOrder: null,
          result,
        },
      ],
    })

  it('does not grey or strike the card it just promoted', () => {
    render(
      <Stage
        view={picking({ A: 0 }, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )

    const chosen = document.querySelector('.side--own .cell-slot--chosen')!
    expect(chosen.textContent).toContain('The Anvil')
    // `cell--spent` is what carries the strikethrough and the fade.
    expect(chosen.querySelector('.cell--spent')).toBeNull()
    expect(chosen.querySelector('.portrait--dim')).toBeNull()
    expect(offsetOf('The Anvil')).toBe(0) // and it is still centre stage
  })

  it('greys it and sends it out once it is no longer the selection', () => {
    // The round moved on: nothing is selected now, and the consumed slot reads as spent.
    render(
      <Stage
        view={picking(undefined, 'A')}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )

    expect(document.querySelector('.side--own .cell--spent')).toBeTruthy()
    expect(offsetOf('The Anvil')).toBeGreaterThan(offsetOf('The Cartographer'))
  })

  it('steps the rest of the side back instead of dimming the pick', () => {
    // Same contrast, opposite direction — and it cannot be confused with the grey that means
    // "spent", because it is applied to everything *except* the card in question.
    const { container } = render(
      <Stage
        view={picking({ A: 0 }, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    expect(container.querySelector('.side--own .side__row--focused')).toBeTruthy()
  })

  it('gives both sides the same floor, so nothing hangs from the ceiling', () => {
    // The rows used to size themselves. The side with a card at centre stage grew taller, and
    // since the two are grid items the shorter one hung from the top while its opposite stood on
    // the ground — the cards no longer faced each other across a line.
    const { container } = render(
      <Stage
        view={picking({ A: 0 }, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    const rows = [...container.querySelectorAll('.side__row')] as HTMLElement[]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.style.height).toBe(rows[1]!.style.height)
    // Only one side has a pick, and only that side dims its own also-rans.
    expect(container.querySelectorAll('.side__row--focused')).toHaveLength(1)
  })

  it('reserves the room when it is *their* pick that grows, not only yours', () => {
    // The asymmetric direction, and the one a naive fix misses: reading the height off your own
    // side alone looks correct in every test where you are the one who picked first.
    const { container } = render(
      <Stage
        view={picking({ B: 0 }, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    const rows = [...container.querySelectorAll('.side__row')] as HTMLElement[]
    expect(rows[0]!.style.height).toBe(rows[1]!.style.height)
    // And the room is genuinely reserved, rather than both sides agreeing on the short height.
    expect(parseInt(rows[0]!.style.height, 10)).toBeGreaterThan(Math.round(132 * (300 / 199)) + 26)
  })

  it('reserves the taller row only when something is actually blown up', () => {
    // Reserving 1.5× height always left a band of dead space under every row for the whole draft.
    const idle = render(
      <Stage
        view={picking(undefined, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    const idleHeight = (idle.container.querySelector('.side--own .side__row') as HTMLElement).style
      .height
    cleanup()

    const active = render(
      <Stage
        view={picking({ A: 0 }, null)}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    const activeHeight = (active.container.querySelector('.side--own .side__row') as HTMLElement)
      .style.height

    expect(parseInt(activeHeight, 10)).toBeGreaterThan(parseInt(idleHeight, 10))
  })
})

/**
 * The reveal has to be on screen to be seen.
 *
 * It was not. The board sat inside the roll gate, and the reveal and the roll arrive in the
 * *same* server frame — committing fires `pickReveal`, which opens round one, which fires the
 * ROLL, and the server drains all of it in one settle and sends one view. So the client went
 * straight to "dice pending", the board was unmounted, and the animation played to nobody.
 */
describe('the reveal is not trampled by the roll', () => {
  it('holds the dice back until the reveal has finished', () => {
    // `Match` gates DiceRoll on `!revealing`, and the reveal's own duration is exported from
    // Stage so the two cannot drift.
    const SRC = readFileSync('apps/web/src/screens/Match.tsx', 'utf8')
    expect(SRC).toContain('!revealing ? (')
    expect(SRC).toContain('revealDurationMs(expectedSlots)')
  })

  it('keeps the board mounted while the dice are in the air', () => {
    const SRC = readFileSync('apps/web/src/screens/Match.tsx', 'utf8')
    const stageAt = SRC.indexOf('<Stage')
    const gateAt = SRC.indexOf('{rollPlaying || revealing ? null : (')
    expect(stageAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(-1)
    // The board is rendered before the gate, so nothing the gate hides can take it with it.
    expect(stageAt).toBeLessThan(gateAt)
  })

  it('runs long enough for the last card to finish turning', () => {
    // The first version timed the reveal at `slots * 150 + 600`, which cut the final two cards
    // off — the last delay alone is 1050ms and the flip itself is another 420ms.
    expect(revealDurationMs(4)).toBeGreaterThanOrEqual(1050 + 420)
    expect(revealDurationMs(3)).toBeGreaterThanOrEqual(750 + 420)
  })
})

/**
 * "Round banned" means banned *this* round.
 *
 * `bannedInRound` is null on a slot nobody banned; `currentRound` is null whenever there is no
 * round — through the ban and draft phases, and again once the match is over. Comparing the two
 * directly makes `null === null` true, so every unbanned slot stamps itself the moment the
 * roster is revealed and again on the final screen. Both are asserted, because they are two
 * different sources of the same null.
 */
describe('the round-ban stamp only appears for a real ban', () => {
  const board = (phase: PlayerView['phase'], slots: Slot[], status: 'IN_PROGRESS' | 'COMPLETE') =>
    view({
      status,
      phase,
      you: { seat: 'A', score: 0, hasCommitted: true, slotCount: slots.length, slots },
      opponent: { seat: 'B', score: 0, hasCommitted: true, slotCount: slots.length, slots: [] },
    })

  it('stays off the whole roster the moment it is revealed', () => {
    // The draft phase reports `roundIndex: null`, which used to match every unbanned slot.
    render(
      <Stage
        view={board(
          { moduleId: 'draft', type: 'SIMULTANEOUS_COMMIT', roundIndex: null, awaiting: ['B'] },
          [slot(0, 'anvil'), slot(1, 'cartographer'), slot(2, 'duelist')],
          'IN_PROGRESS',
        )}
        expected={3}
        mine={{ filled: 3 }}
        theirs={{ filled: 3 }}
      />,
    )
    expect(screen.queryByText('Round banned')).toBeNull()
  })

  it('stays off the board once the match is over', () => {
    // No phase at all here, so `currentRound` is null from a second direction.
    render(
      <Stage
        view={board(
          null,
          [
            slot(0, 'anvil', { consumed: true }),
            slot(1, 'cartographer', { consumed: true }),
            slot(2, 'duelist', { consumed: true }),
          ],
          'COMPLETE',
        )}
        expected={3}
        mine={{ filled: 3 }}
        theirs={{ filled: 3 }}
      />,
    )
    expect(screen.queryByText('Round banned')).toBeNull()
  })

  it('still appears for the slot actually banned this round', () => {
    render(
      <Stage
        view={board(
          { moduleId: 'rounds.1.select', type: 'SELECT', roundIndex: 1, awaiting: ['A'] },
          [slot(0, 'anvil', { bannedInRound: 1 }), slot(1, 'cartographer'), slot(2, 'duelist')],
          'IN_PROGRESS',
        )}
        expected={3}
        mine={{ filled: 3 }}
        theirs={{ filled: 3 }}
      />,
    )
    expect(screen.getAllByText('Round banned')).toHaveLength(1)
  })

  it('drops the stamp once the round it belonged to has passed', () => {
    // D3 — a round ban lasts one round. Banned in round 0, we are now in round 1.
    render(
      <Stage
        view={board(
          { moduleId: 'rounds.1.select', type: 'SELECT', roundIndex: 1, awaiting: ['A'] },
          [slot(0, 'anvil', { bannedInRound: 0 }), slot(1, 'cartographer')],
          'IN_PROGRESS',
        )}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    expect(screen.queryByText('Round banned')).toBeNull()
  })
})

/**
 * A card carries its own history.
 *
 * A spent slot was played in some round, and that round has a result — so it can say what it did
 * rather than becoming an anonymous grey square. Per seat, because one round is a win for one
 * player and a loss for the other.
 */
describe('played cards remember their result', () => {
  const finished = (
    result: 'A' | 'B' | 'TIE',
    status: 'IN_PROGRESS' | 'COMPLETE' = 'IN_PROGRESS',
  ) =>
    view({
      status,
      outcome: status === 'COMPLETE' ? (result === 'TIE' ? 'DRAW' : result) : null,
      phase:
        status === 'COMPLETE'
          ? null
          : { moduleId: 'rounds.1.ban', type: 'BAN', roundIndex: 1, awaiting: ['A'] },
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 2,
        slots: [slot(0, 'anvil', { consumed: true }), slot(1, 'cartographer')],
      },
      opponent: {
        seat: 'B',
        score: 0,
        hasCommitted: true,
        slotCount: 2,
        slots: [slot(0, 'duelist', { consumed: true }), slot(1, 'gambler')],
      },
      rounds: [
        {
          index: 0,
          privilegeHolder: 'A',
          turnOrderHolder: null,
          roll: null,
          ban: null,
          selection: { A: 0, B: 0 } as never,
          selectionCommitted: { A: true, B: true },
          playOrder: null,
          result,
        },
      ],
    })

  it('marks the same round a win for one side and a loss for the other', () => {
    const { container } = render(
      <Stage view={finished('A')} expected={2} mine={{ filled: 2 }} theirs={{ filled: 2 }} />,
    )
    expect(container.querySelector('.side--own .cell--win')).toBeTruthy()
    expect(container.querySelector('.side--opponent .cell--loss')).toBeTruthy()
    // And the unplayed slots carry no verdict at all.
    expect(container.querySelectorAll('.cell--win')).toHaveLength(1)
  })

  it('marks a tied round on both sides', () => {
    const { container } = render(
      <Stage view={finished('TIE')} expected={2} mine={{ filled: 2 }} theirs={{ filled: 2 }} />,
    )
    expect(container.querySelectorAll('.cell--tie')).toHaveLength(2)
    expect(container.querySelector('.cell--win')).toBeNull()
  })

  it('crowns the winner and steps the loser back at the end', () => {
    const { container } = render(
      <Stage
        view={finished('A', 'COMPLETE')}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    expect(container.querySelector('.side--own.side--won')).toBeTruthy()
    expect(container.querySelector('.side--opponent.side--lost')).toBeTruthy()
  })

  it('crowns nobody on a draw', () => {
    const { container } = render(
      <Stage
        view={finished('TIE', 'COMPLETE')}
        expected={2}
        mine={{ filled: 2 }}
        theirs={{ filled: 2 }}
      />,
    )
    expect(container.querySelector('.side--won')).toBeNull()
    expect(container.querySelector('.side--lost')).toBeNull()
    expect(container.querySelectorAll('.side--draw')).toHaveLength(2)
  })

  it('says nothing about a round still being played', () => {
    // A result of null means the round is live — no verdict to carry yet.
    const live = finished('A')
    live.rounds[0]!.result = null
    const { container } = render(
      <Stage view={live} expected={2} mine={{ filled: 2 }} theirs={{ filled: 2 }} />,
    )
    expect(container.querySelector('.cell--win')).toBeNull()
    expect(container.querySelector('.cell--loss')).toBeNull()
  })
})

/**
 * Locking in together.
 *
 * Two rings say "I have chosen", twice. One ring around the pair says "we are locked in", which
 * is a different statement — so it arrives after a beat, and the individual glows stand down when
 * it does.
 */
describe('the pair locks in', () => {
  const both = (a: number | null, b: number | null) =>
    view({
      phase: { moduleId: 'rounds.0.report', type: 'REPORT_RESULT', roundIndex: 0, awaiting: ['A'] },
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 2,
        slots: [slot(0, 'anvil'), slot(1, 'cartographer')],
      },
      opponent: {
        seat: 'B',
        score: 0,
        hasCommitted: true,
        slotCount: 2,
        slots: [slot(0, 'duelist'), slot(1, 'gambler')],
      },
      rounds: [
        {
          index: 0,
          privilegeHolder: 'A',
          turnOrderHolder: null,
          roll: null,
          ban: null,
          selection: { ...(a === null ? {} : { A: a }), ...(b === null ? {} : { B: b }) } as never,
          selectionCommitted: { A: a !== null, B: b !== null },
          playOrder: null,
          result: null,
        },
      ],
    })

  const render2 = (v: PlayerView) =>
    render(<Stage view={v} expected={2} mine={{ filled: 2 }} theirs={{ filled: 2 }} />)

  it('shows no joined ring while only one side has picked', () => {
    vi.useFakeTimers()
    const { container } = render2(both(0, null))
    act(() => void vi.advanceTimersByTime(3000))
    expect(container.querySelector('.lockin')).toBeNull()
    vi.useRealTimers()
  })

  it('holds the joined ring back for a beat after the second pick', () => {
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    // The second card arrives and pulses on its own first — that beat is what makes the join
    // read as a transition rather than a third state that was always there.
    expect(container.querySelector('.lockin')).toBeNull()

    act(() => void vi.advanceTimersByTime(1000))
    expect(container.querySelector('.lockin')).toBeTruthy()
    vi.useRealTimers()
  })

  it('stands the individual glows down once the pair ring is up', () => {
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    act(() => void vi.advanceTimersByTime(1000))
    // Two rings become one, rather than three things glowing at once.
    expect(container.querySelector('.stage__sides--locked')).toBeTruthy()
    vi.useRealTimers()
  })

  it('joins immediately under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }))
    const { container } = render2(both(0, 0))
    expect(container.querySelector('.lockin')).toBeTruthy()
  })

  it('encloses the pair rather than tracing them', () => {
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    act(() => void vi.advanceTimersByTime(1000))
    const ring = container.querySelector('.lockin') as HTMLElement

    // Two blown-up cells, the gap either side of the "vs", the "vs" column, and padding.
    const cardsWide = Math.round(132 * 1.5) * 2 + 8 * 2 + 44
    expect(parseInt(ring.style.width, 10)).toBeGreaterThan(cardsWide)

    // Tall enough for the whole card, not just its portrait — the first version measured the art
    // alone and cut across the names underneath it.
    const portraitOnly = Math.round(132 * (300 / 199) * 1.5)
    const wholeCard = Math.round((132 * (300 / 199) + 26) * 1.5)
    expect(parseInt(ring.style.height, 10)).toBeGreaterThan(wholeCard)
    expect(wholeCard).toBeGreaterThan(portraitOnly)

    // And it hangs below the cards' floor by its own padding, so the bottom edge clears them too.
    expect(parseInt(ring.style.bottom, 10)).toBeLessThan(0)
    vi.useRealTimers()
  })

  it('draws the ring above every card, including the small ones beside it', () => {
    // The ring is wider than the pair it encloses — that is the point — so its edges pass over
    // the cards on either side. Underneath them it was simply invisible.
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    act(() => void vi.advanceTimersByTime(1000))

    const ring = Number((container.querySelector('.lockin') as HTMLElement).style.zIndex)
    const cells = [...container.querySelectorAll('.cell-slot')] as HTMLElement[]
    expect(cells.length).toBeGreaterThan(2) // there are neighbours to be hidden behind
    for (const cell of cells) {
      expect(ring).toBeGreaterThan(Number(cell.style.zIndex))
    }
    vi.useRealTimers()
  })

  it('still lifts the chosen card above its own neighbours', () => {
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    act(() => void vi.advanceTimersByTime(1000))
    const own = [...container.querySelectorAll('.side--own .cell-slot')] as HTMLElement[]
    const chosen = own.find((c) => c.className.includes('cell-slot--chosen'))!
    const others = own.filter((c) => c !== chosen)
    for (const other of others) {
      expect(Number(chosen.style.zIndex)).toBeGreaterThan(Number(other.style.zIndex))
    }
    vi.useRealTimers()
  })

  it('gives the blown-up card a row tall enough to hold it', () => {
    // Scaling a card scales its name and padding too. Sizing the row from the portrait alone
    // left the chosen card overflowing its own row by about thirteen pixels.
    vi.useFakeTimers()
    const { container } = render2(both(0, 0))
    act(() => void vi.advanceTimersByTime(1000))
    const row = container.querySelector('.side__row') as HTMLElement
    expect(parseInt(row.style.height, 10)).toBeGreaterThanOrEqual(
      Math.round((132 * (300 / 199) + 26) * 1.5),
    )
    vi.useRealTimers()
  })
})

/**
 * The final screen says who won, in colour.
 */
describe('the winner keeps its colour at the end', () => {
  it('does not grey the characters that did the winning', () => {
    // A played character is `spent`, which greys it — right all match, and exactly backwards
    // here. It left the winner showing its winning characters dim and the one it never played
    // bright, which is the opposite of what the result says.
    expect(CSS_TEXT).toMatch(/\.side--won \.cell--spent \{[^}]*opacity:\s*1/)
    expect(CSS_TEXT).toMatch(/\.side--won \.cell--spent \{[^}]*text-decoration:\s*none/)
    expect(CSS_TEXT).toMatch(/\.side--won \.portrait--dim \{[^}]*filter:\s*none/)
  })

  it('greys the losing side whole, as part of the end sequence', () => {
    // The greying moved into the `recede` animation when the ending became ordered — the loser
    // steps back *first*, then the winner rises. A static filter could not express that.
    expect(CSS_TEXT).toMatch(/\.side--lost \.cell \{[^}]*animation:\s*recede/)
    expect(CSS_TEXT).toMatch(/@keyframes recede \{[^]*?filter:\s*saturate\(0\.25\)/)
  })
})
