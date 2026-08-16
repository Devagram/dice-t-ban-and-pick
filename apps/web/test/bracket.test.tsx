import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Bracket } from '../src/components/Bracket.js'
import type { BracketSlot, SlotStatus, TournamentView } from '../src/api.js'

afterEach(cleanup)

/**
 * **D37 Phase 6 — the bracket graphic.**
 *
 * Two things worth testing and one worth not. The layout is a pure function, so it can be checked
 * without a renderer that lays out — every coordinate is asserted from the DOM directly. The
 * accessible list has to say the same thing as the drawing, which is the failure mode of every
 * "and also an aria version" that drifts. What is *not* tested is whether it looks nice.
 */

const entrant = (i: number) => ({
  entrantId: `t${i}`,
  playerId: `p${i}`,
  displayName: `Player ${i}`,
  seed: i,
})

function slot(over: Partial<BracketSlot> & { id: string }): BracketSlot {
  const { id, ...rest } = over
  return {
    slot: {
      id,
      side: id.startsWith('W') ? 'WINNERS' : id.startsWith('L') ? 'LOSERS' : 'GRAND_FINAL',
      round: Number(/\d+/.exec(id)?.[0] ?? 1),
      match: Number(id.split('M')[1] ?? 1),
      winnerTo: null,
      loserTo: null,
      ...rest.slot,
    },
    status: 'PENDING',
    entrants: [null, null],
    winner: null,
    position: 'WINNERS',
    modeId: 'base',
    roomCode: null,
    ...rest,
  }
}

/** A 4-entrant single-elimination bracket with the semis played. */
function view(over: Partial<TournamentView> = {}): TournamentView {
  return {
    code: 'T-ABC123',
    status: 'RUNNING',
    format: 'SINGLE_ELIMINATION',
    grandFinalReset: false,
    createdAt: Date.now(),
    entrants: [1, 2, 3, 4].map(entrant),
    slots: [
      slot({
        id: 'W1M1',
        slot: { id: 'W1M1', side: 'WINNERS', round: 1, match: 1, winnerTo: 'W2M1', loserTo: null },
        status: 'DONE',
        entrants: ['t1', 't4'],
        winner: 't1',
      }),
      slot({
        id: 'W1M2',
        slot: { id: 'W1M2', side: 'WINNERS', round: 1, match: 2, winnerTo: 'W2M1', loserTo: null },
        status: 'READY',
        entrants: ['t2', 't3'],
      }),
      slot({
        id: 'W2M1',
        slot: { id: 'W2M1', side: 'WINNERS', round: 2, match: 1, winnerTo: null, loserTo: null },
        entrants: ['t1', null],
      }),
    ],
    champion: null,
    complete: false,
    ...over,
  }
}

const boxes = (container: HTMLElement) => [...container.querySelectorAll('g.bslot')]

/**
 * Looked up by `data-slot`, not by the label.
 *
 * The label is not a handle: D40's reset box reads "reset" rather than "GF2", which is right for
 * a reader and useless for a test.
 */
const boxFor = (container: HTMLElement, id: string) =>
  container.querySelector(`g.bslot[data-slot="${id}"]`)!

describe('the drawing', () => {
  it('draws one box per slot, and a link along each winner’s path', () => {
    const { container } = render(<Bracket view={view()} />)
    expect(boxes(container)).toHaveLength(3)
    // W1M1 → W2M1 and W1M2 → W2M1. The final routes nowhere.
    expect(container.querySelectorAll('path.bracket__link')).toHaveLength(2)
  })

  it('lays out rounds left to right, with the later round further right', () => {
    const { container } = render(<Bracket view={view()} />)
    const xOf = (id: string) =>
      Number(/translate\(([\d.]+) /.exec(boxFor(container, id).getAttribute('transform')!)![1])

    expect(xOf('W2M1')).toBeGreaterThan(xOf('W1M1'))
    expect(xOf('W1M1')).toBe(xOf('W1M2'))
  })

  it('centres a round-two box between the two that feed it', () => {
    // The classic bracket shape, and it falls out of the even-spread layout rather than being
    // computed — which is why it is worth checking that it actually did.
    const { container } = render(<Bracket view={view()} />)
    const yOf = (id: string) =>
      Number(
        /translate\([\d.]+ ([\d.]+)\)/.exec(boxFor(container, id).getAttribute('transform')!)![1],
      )

    const midpoint = (yOf('W1M1') + yOf('W1M2')) / 2
    expect(yOf('W2M1')).toBeCloseTo(midpoint, 1)
  })

  it('names an unfilled side by where its occupant will come from', () => {
    const { container } = render(<Bracket view={view()} />)
    // "to be decided" tells a reader nothing they could act on; the feeding slot does.
    expect(boxFor(container, 'W2M1').textContent).toContain('winner of')
  })

  it('marks the winner of a decided slot, and shows the mode on every one', () => {
    const { container } = render(<Bracket view={view()} />)
    const done = boxFor(container, 'W1M1')
    expect(within(done as HTMLElement).getByText('Player 1')).toHaveProperty(
      'classList.value',
      expect.stringContaining('bslot__name--won'),
    )
    // A Bo1 losers bracket beside a Bo3 winners bracket is the feature; a drawing that does not
    // say which is which hides it.
    for (const box of boxes(container)) expect(box.textContent).toContain('base')
  })

  it('is hidden from screen readers, because the list below says the same thing', () => {
    const { container } = render(<Bracket view={view()} />)
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('every slot state is visually distinct', () => {
  const states: SlotStatus[] = [
    'PENDING',
    'READY',
    'LIVE',
    'DONE',
    'BYE',
    'DISPUTED',
    'VOIDED',
    'DRAWN',
  ]

  it.each(states)('renders %s with its own class', (status) => {
    const { container } = render(
      <Bracket view={view({ slots: [slot({ id: 'W1M1', status, entrants: ['t1', 't2'] })] })} />,
    )
    expect(container.querySelector(`g.bslot--${status.toLowerCase()}`)).not.toBeNull()
  })

  it('names the three states that are questions for a person', () => {
    // D38's dispute, D39's void, and a draw are all "stuck", and the organiser is being asked
    // something different by each. One word for all three would ask the wrong one.
    for (const [status, label] of [
      ['DISPUTED', 'disputed'],
      ['VOIDED', 'voided'],
      ['DRAWN', 'needs a decision'],
    ] as const) {
      cleanup()
      const { container } = render(
        <Bracket view={view({ slots: [slot({ id: 'W1M1', status, entrants: ['t1', 't2'] })] })} />,
      )
      expect(container.textContent).toContain(label)
    }
  })

  it('highlights the viewer’s own match and nobody else’s', () => {
    const { container } = render(<Bracket view={view()} youArePlayerId="p2" />)
    const mine = container.querySelectorAll('g.bslot--mine')
    // p2 is entrant t2, who is in W1M2 only.
    expect(mine).toHaveLength(1)
    expect(mine[0]!.textContent).toContain('W1M2')
  })

  it('highlights nothing for a spectator', () => {
    const { container } = render(<Bracket view={view()} />)
    expect(container.querySelectorAll('g.bslot--mine')).toHaveLength(0)
  })
})

describe('D40 — the reset', () => {
  const doubleElim = (over: Partial<BracketSlot> = {}) =>
    view({
      format: 'DOUBLE_ELIMINATION',
      grandFinalReset: true,
      slots: [
        slot({ id: 'GF', status: 'DONE', entrants: ['t1', 't2'], winner: 't2' }),
        slot({ id: 'GF2', ...over }),
      ],
    })

  it('labels the reset as a reset rather than as a second grand final', () => {
    const { container } = render(<Bracket view={doubleElim({ status: 'READY' })} />)
    expect(container.textContent).toContain('reset')
  })

  it('draws it below the grand final rather than beside it', () => {
    const { container } = render(<Bracket view={doubleElim({ status: 'READY' })} />)
    const yOf = (id: string) =>
      Number(
        /translate\([\d.]+ ([\d.]+)\)/.exec(boxFor(container, id).getAttribute('transform')!)![1],
      )
    expect(yOf('GF2')).toBeGreaterThan(yOf('GF'))
  })
})

describe('the accessible list is the same bracket', () => {
  it('lists every slot the drawing draws', () => {
    render(<Bracket view={view()} />)
    const list = screen.getByRole('list', { name: 'Bracket' })
    const text = list.textContent ?? ''
    for (const id of ['W1M1', 'W1M2', 'W2M1']) expect(text).toContain(id)
  })

  it('groups by round, and names the round', () => {
    render(<Bracket view={view()} />)
    expect(screen.getByText('Winners round 1')).toBeTruthy()
    expect(screen.getByText('Winners round 2')).toBeTruthy()
  })

  it('says who is in each match, who won, and under which mode', () => {
    render(<Bracket view={view()} />)
    const list = screen.getByRole('list', { name: 'Bracket' })
    expect(list.textContent).toContain('Player 1 versus Player 4')
    expect(list.textContent).toContain('won by Player 1')
    expect(list.textContent).toContain('base')
    // An undecided side says so rather than being blank.
    expect(list.textContent).toContain('to be decided')
  })

  it('names the grand final and its reset separately', () => {
    render(
      <Bracket
        view={view({
          format: 'DOUBLE_ELIMINATION',
          slots: [slot({ id: 'GF' }), slot({ id: 'GF2' })],
        })}
      />,
    )
    expect(screen.getByText('Grand final')).toBeTruthy()
    expect(screen.getByText('Grand final reset')).toBeTruthy()
  })
})

describe('sizing', () => {
  /** A full double-elimination bracket at `n` entrants, shaped like the server's. */
  function big(n: number): TournamentView {
    const rounds = Math.ceil(Math.log2(n))
    const slots: BracketSlot[] = []
    for (let r = 1; r <= rounds; r++) {
      for (let m = 1; m <= 2 ** (rounds - r); m++) {
        slots.push(
          slot({
            id: `W${r}M${m}`,
            slot: {
              id: `W${r}M${m}`,
              side: 'WINNERS',
              round: r,
              match: m,
              winnerTo: r < rounds ? `W${r + 1}M${Math.ceil(m / 2)}` : 'GF',
              loserTo: null,
            },
          }),
        )
      }
    }
    for (let r = 1; r <= 2 * (rounds - 1); r++) {
      const count = 2 ** (rounds - Math.ceil(r / 2) - 1)
      for (let m = 1; m <= count; m++) {
        slots.push(
          slot({
            id: `L${r}M${m}`,
            slot: {
              id: `L${r}M${m}`,
              side: 'LOSERS',
              round: r,
              match: m,
              winnerTo: null,
              loserTo: null,
            },
          }),
        )
      }
    }
    slots.push(slot({ id: 'GF' }))
    return view({ format: 'DOUBLE_ELIMINATION', entrants: [], slots })
  }

  it.each([4, 8, 16, 32])('renders %i entrants without the page scrolling sideways', (n) => {
    const { container } = render(<Bracket view={big(n)} />)
    const svg = container.querySelector('svg')!

    // The width lives on the SVG and the scrolling on its own container. If the wide thing were
    // the page, every other screen would feel broken on a phone.
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0)
    expect(container.querySelector('.bracket__scroll')).not.toBeNull()
    expect(svg.closest('.bracket__scroll')).not.toBeNull()
  })

  it('grows wider with more rounds, and taller with more entrants', () => {
    const small = render(<Bracket view={big(4)} />).container.querySelector('svg')!
    cleanup()
    const large = render(<Bracket view={big(32)} />).container.querySelector('svg')!

    expect(Number(large.getAttribute('width'))).toBeGreaterThan(Number(small.getAttribute('width')))
    expect(Number(large.getAttribute('height'))).toBeGreaterThan(
      Number(small.getAttribute('height')),
    )
  })
})
