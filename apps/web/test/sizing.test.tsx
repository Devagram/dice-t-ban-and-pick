import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

import { RoundStrip } from '../src/components/RoundStrip.js'
import { Stage } from '../src/components/Stage.js'
import { view } from './fixtures.js'

/**
 * Sizing, asserted on the stylesheet rather than on a rendered box.
 *
 * happy-dom does not lay anything out — every `getBoundingClientRect` is zero — so a test that
 * measured elements would pass no matter what the CSS said. What *can* be checked is that the
 * rules expressing the intent exist and stand in the right relation, which is where these
 * particular bugs live: two numbers written in two places that drift apart.
 */
const CSS = readFileSync('apps/web/src/styles.css', 'utf8')

/** Reads a `--name: 123px` token. Parsed by hand rather than by regex — an escape inside a
 *  template literal is silently swallowed, which made the first version of this match nothing. */
const tokenPx = (name: string): number => {
  const line = CSS.split(/\r?\n/).find((l) => l.trim().startsWith(`--${name}:`))
  if (!line) throw new Error(`no --${name} token in styles.css`)
  const value = Number(line.split(':')[1]!.trim().split('px')[0])
  if (!Number.isFinite(value)) throw new Error(`--${name} is not a px value: ${line}`)
  return value
}

beforeEach(() => {
  cleanup()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})

describe('the drafted row reads larger than the roster', () => {
  it('states the hierarchy as tokens, not as two unrelated numbers', () => {
    // A fighting game shows chosen fighters large and the pick-from roster small. If these ever
    // invert, the board stops being the thing your eye lands on.
    expect(tokenPx('stage-cell')).toBeGreaterThan(tokenPx('roster-tile'))
  })

  it('sizes the roster grid from its token rather than from a literal', () => {
    expect(CSS).toContain('minmax(var(--roster-tile), 1fr)')
  })

  it('keeps the sides gap agreed between the CSS and the lock-in ring', () => {
    // The ring spans both cards *and the space either side of the "vs"*. That gap lives on
    // `.stage__sides` in CSS and as `SIDES_GAP_PX` in the ring maths — the third pair of this
    // kind on this board, and the first version of the ring used the wrong one of the two gaps.
    const STAGE = readFileSync('apps/web/src/components/Stage.tsx', 'utf8')
    const declared = /^const SIDES_GAP_PX = (\d+)$/m.exec(STAGE)
    expect(declared, 'no SIDES_GAP_PX in Stage.tsx').toBeTruthy()
    const css = /\.stage__sides \{[^}]*gap:\s*(\d+)px/.exec(CSS)
    expect(css, 'no gap on .stage__sides').toBeTruthy()
    expect(Number(declared![1])).toBe(Number(css![1]))
  })

  it('keeps the vs column width agreed between the CSS and the lock-in ring', () => {
    // The joined ring is sized in TypeScript from the two cards, the gaps, and this column. If
    // the column changes in CSS alone the ring stops lining up with what it encloses — the same
    // two-statements-of-one-number trap as CELL_PX below.
    const STAGE = readFileSync('apps/web/src/components/Stage.tsx', 'utf8')
    const declared = /^const VS_WIDTH_PX = (\d+)$/m.exec(STAGE)
    expect(declared, 'no VS_WIDTH_PX in Stage.tsx').toBeTruthy()
    const css = /\.stage__vs \{[^}]*width:\s*(\d+)px/.exec(CSS)
    expect(css, 'no width on .stage__vs').toBeTruthy()
    expect(Number(declared![1])).toBe(Number(css![1]))
  })

  it('keeps the stage cell width agreed between the CSS token and the layout maths', () => {
    // Stage cells are absolutely positioned and moved by `transform`, so their pitch is computed
    // in TypeScript rather than by a grid. That makes `CELL_PX` and `--stage-cell` two
    // statements of one number, in two languages — exactly the pair that drifts.
    const STAGE = readFileSync('apps/web/src/components/Stage.tsx', 'utf8')
    const declared = /^const CELL_PX = (\d+)$/m.exec(STAGE)
    expect(declared, 'no CELL_PX in Stage.tsx').toBeTruthy()
    expect(Number(declared![1])).toBe(tokenPx('stage-cell'))
  })
})

describe('an empty slot occupies exactly what a portrait will', () => {
  it('shares one geometry rule between the portrait and the placeholder', () => {
    // Written as a single selector list on purpose: matching a portrait's box by repeating its
    // width and aspect-ratio elsewhere is how a row ends up with cells that are almost the same
    // size. If this rule is ever split, this test should fail.
    expect(CSS).toMatch(/\.portrait--card,\s*\.cell__frame\s*\{[^}]*aspect-ratio:\s*199 \/ 300/)
  })

  it('renders the placeholder as a framed box, not a bare glyph', () => {
    const v = view({
      you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
    })
    render(
      <Stage view={v} expected={4} mine={{ filled: 1, picks: ['anvil'] }} theirs={{ filled: 2 }} />,
    )

    // One filled portrait and three placeholders on your side; two "chosen" and two empty on
    // theirs. Every one of them is a box, so the row cannot reflow as picks land.
    expect(document.querySelectorAll('.portrait--card').length).toBe(1)
    expect(document.querySelectorAll('.cell__frame').length).toBe(7)
    expect(document.querySelector('.cell__face')).toBeNull() // the old bare glyph is gone
  })
})

describe('the roster does not carry its own scrollbar on a wide screen', () => {
  it('drops the inner scroll region above 900px', () => {
    // The cap earns its place on a phone, where the roster would otherwise bury the commit
    // button. On a laptop it is a second thing to scroll inside the first.
    expect(CSS).toMatch(/@media \(min-width: 900px\) \{\s*\.picker__grid \{[^}]*max-height:\s*none/)
    expect(CSS).toMatch(
      /@media \(min-width: 900px\) \{\s*\.picker__grid \{[^}]*overflow-y:\s*visible/,
    )
  })

  it('gives the match screen room to need one less', () => {
    expect(CSS).toMatch(/\.screen--wide \{\s*max-width:\s*1240px/)
  })
})

/**
 * The round strip earns its place only once there are rounds.
 *
 * `roundIndex` is null for every pre-round module (ban, draft, reveal) and a number from the
 * first roll on — verified against the live wire in `apps/worker/test/round-strip.test.ts`.
 */
describe('R1 R2 R3 waits for the game to start', () => {
  const at = (roundIndex: number | null, status: 'IN_PROGRESS' | 'COMPLETE' = 'IN_PROGRESS') =>
    view({
      status,
      phase:
        roundIndex === null
          ? { moduleId: 'draft', type: 'SIMULTANEOUS_COMMIT', roundIndex: null, awaiting: ['A'] }
          : {
              moduleId: `rounds.${roundIndex}.ban`,
              type: 'BAN',
              roundIndex: roundIndex as 0 | 1 | 2,
              awaiting: ['A'],
            },
    })

  it('shows nothing during the ban and draft phases', () => {
    const { container } = render(<RoundStrip view={at(null)} />)
    expect(container.innerHTML).toBe('')
  })

  it('appears once a round is under way', () => {
    render(<RoundStrip view={at(0)} />)
    expect(screen.getByText('R1')).toBeTruthy()
    expect(screen.getByText('R3')).toBeTruthy()
  })

  it('stays on a finished match, where it is the scoreline', () => {
    render(<RoundStrip view={at(null, 'COMPLETE')} />)
    expect(screen.getByText('R1')).toBeTruthy()
  })
})

/**
 * Every modifier has a base rule to modify.
 *
 * Twice now a `--modifier` has outlived the rule it was modifying: once when a second
 * `.tile__name` was appended and silently dropped the first one's padding and weight, and once
 * when a splice that replaced `.side__row` ran to the next selector and took `.cell` with it.
 * The second left bare dashed boxes with square corners, because the modifiers were suddenly
 * doing all the drawing and none of them had ever been asked to.
 *
 * Neither showed up in a test: every assertion was about a modifier, and the modifiers were fine.
 */
describe('BEM modifiers still have their base rule', () => {
  const selectors = CSS.match(/^\.[a-z][a-z0-9_-]*/gm) ?? []
  const defined = new Set(selectors)

  it('defines a base class for every --modifier in the stylesheet', () => {
    const orphans = [...new Set(selectors.filter((s) => s.includes('--')))]
      .map((s) => ({ modifier: s, base: s.slice(0, s.indexOf('--')) }))
      // Bases that intentionally carry no rule of their own — either a bare layout slot with
      // nothing to say, or an element styled only in context. Adding to this list is a claim
      // that the base was *never* there, which is a different thing from it having vanished.
      .filter(
        ({ base }) =>
          ![
            '.screen', // page shell; every variant sets its own width
            '.btn',
            '.chip',
            '.conn',
            '.outcome',
            '.round',
            '.side', // a grid slot; the row inside it does the drawing
            '.bancell__name', // styled through `.bancell--placed .bancell__name`
          ].includes(base),
      )
      .filter(({ base }) => !defined.has(base))

    expect(orphans).toEqual([])
  })

  it('keeps the board card drawn by its base rule, not by its states', () => {
    // The specific shape of the regression: `.cell` carries the radius, padding and background;
    // `.cell--empty` and friends only change the border. Losing the base is invisible until you
    // look at the thing.
    expect(CSS).toMatch(/^\.cell \{[^}]*border-radius:/m)
    expect(CSS).toMatch(/^\.cell \{[^}]*background:/m)
    expect(CSS).toMatch(/^\.cell \{[^}]*padding:/m)
  })
})

/**
 * The board is a fixed object that scales, not a reflowing one.
 *
 * Desktop-first as of 2026-07-31 — the 390px criterion was struck rather than left quietly
 * failing (see docs/DELIVERY-PLAN.md). What remains is that a small laptop or a half-width window
 * still gets a whole board, by shrinking it rather than by rearranging it.
 */
describe('the board fits its container by scaling', () => {
  it('keeps its natural width in the markup and scales with a transform', () => {
    const v = view({
      you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
    })
    const { container } = render(
      <Stage view={v} expected={4} mine={{ filled: 0 }} theirs={{ filled: 0 }} />,
    )

    const board = container.querySelector('.stage__board') as HTMLElement
    // 4 cells a side on a 132px pitch with 6px gaps, twice, plus 8px either side of a 44px "vs".
    const side = 4 * 132 + 3 * 6
    expect(board.style.width).toBe(`${side * 2 + 8 * 2 + 44}px`)
    expect(board.style.transform).toContain('scale(')
  })

  it('scales the whole board rather than resizing the cells', () => {
    // The cells' own arithmetic must not move — that is what keeps one set of numbers driving the
    // pitch, the ring and the reveal offsets.
    const v = view({
      you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 0, slots: [] },
    })
    const { container } = render(
      <Stage view={v} expected={4} mine={{ filled: 0 }} theirs={{ filled: 0 }} />,
    )
    const cell = container.querySelector('.cell-slot') as HTMLElement
    expect(cell.style.width).toBe('132px')
  })

  it('does not claim to support a phone anywhere in the delivery plan', () => {
    // The criterion is struck, with the reason recorded. A criterion left silently failing is
    // worse than one deliberately dropped, and this is what stops it drifting back in.
    const PLAN = readFileSync('docs/DELIVERY-PLAN.md', 'utf8')
    expect(PLAN).toContain('~~Usable at 390px width~~')
    expect(PLAN).toContain('desktop-first')
  })
})
