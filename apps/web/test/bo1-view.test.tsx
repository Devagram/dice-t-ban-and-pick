import { cleanup, render, screen } from '@testing-library/react'
import type { RoundView } from '@banpick/types'
import { afterEach, describe, expect, it } from 'vitest'

import { RoundStrip } from '../src/components/RoundStrip.js'
import { view } from './fixtures.js'

afterEach(cleanup)

/**
 * **D36 — the client under a mode that is not a Bo3.**
 *
 * There is nothing mode-specific to write here, and that is the assertion. §11's thin-client rule
 * means the strip renders `view.rounds` and the action bar renders `legalActions`; neither has an
 * opinion about how many rounds a match has or about how many seats may ban. These tests exist to
 * keep it that way — a `R${index + 1}` loop is easy to "improve" into something that assumes three.
 */

/** A one-round view, as the server sends it for `bo1-bring3-ban1`. */
const bo1View = (over: Partial<ReturnType<typeof view>> = {}) => ({
  ...view({ ...over }),
  rounds: [
    {
      index: 0,
      privilegeHolder: null,
      turnOrderHolder: null,
      roll: null,
      ban: {},
      banCommitted: { A: false, B: false },
      selection: {},
      selectionCommitted: { A: false, B: false },
      playOrder: null,
      overtime: false,
      result: null,
    },
  ] as RoundView[],
})

describe('the round strip on a one-round match', () => {
  it('shows a single pip, not three with two that will never be played', () => {
    render(<RoundStrip view={bo1View() as never} />)

    const pips = screen.getByRole('list', { name: 'Rounds' }).querySelectorAll('li')
    expect(pips).toHaveLength(1)
    expect(screen.getByText('R1')).toBeTruthy()
    expect(screen.queryByText('R2')).toBeNull()
    // And no overtime pip: the mode does not declare one, so the server never sends it.
    expect(screen.queryByText('OT')).toBeNull()
  })

  it('says nothing about a ban privilege nobody holds', () => {
    // Both seats ban here, so there is no privilege holder — and the strip must not claim one.
    // `PrivilegeLabel` only names a ban when `privilegeHolder` is set, which is why this holds.
    render(<RoundStrip view={bo1View() as never} />)
    expect(screen.queryByText(/you ban/)).toBeNull()
    expect(screen.queryByText(/they ban/)).toBeNull()
  })

  it('says who plays first once the roll has settled it', () => {
    // Nobody holds turn order in this mode — the dice decided — so without this the strip could
    // only say "—" about the one thing the round had established.
    const v = bo1View()
    v.rounds[0]!.playOrder = { declaredBy: null, first: v.seat }
    render(<RoundStrip view={v as never} />)
    expect(screen.getByText('you play first')).toBeTruthy()

    cleanup()
    const other = bo1View()
    other.rounds[0]!.playOrder = { declaredBy: null, first: other.seat === 'A' ? 'B' : 'A' }
    render(<RoundStrip view={other as never} />)
    expect(screen.getByText('they play first')).toBeTruthy()
  })

  it('still prefers the privilege wording where somebody does hold one', () => {
    // The Bo3 strip must read exactly as it did: play order is the fallback, not a new line.
    const v = bo1View()
    v.rounds[0]!.turnOrderHolder = v.seat
    v.rounds[0]!.playOrder = { declaredBy: v.seat, first: v.seat }
    render(<RoundStrip view={v as never} />)
    expect(screen.getByText('you set order')).toBeTruthy()
    expect(screen.queryByText('you play first')).toBeNull()
  })

  it('reports the result of the only round as the match result', () => {
    const v = bo1View()
    v.rounds[0]!.result = v.seat
    render(<RoundStrip view={{ ...v, status: 'COMPLETE' } as never} />)
    expect(screen.getByText('You won')).toBeTruthy()
  })

  it('renders a drawn Bo1 as a tie rather than as missing data', () => {
    const v = bo1View()
    v.rounds[0]!.result = 'TIE'
    render(<RoundStrip view={{ ...v, status: 'COMPLETE' } as never} />)
    expect(screen.getByText('Tied')).toBeTruthy()
  })
})
