import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PlayerActionPayload } from '@banpick/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ActionBar } from '../src/components/ActionBar.js'
import { RoundStrip } from '../src/components/RoundStrip.js'
import { REPORT_ACTION, view } from './fixtures.js'

afterEach(cleanup)

/**
 * The button says who won; the strip repeats it back. They have to agree, from both seats.
 *
 * Reported as "I click 'I won' and it records that they won", so the test drives the click rather
 * than the payload — a test that constructs the action itself would agree with whichever mapping
 * the code happens to have.
 */
describe('reporting who won', () => {
  for (const seat of ['A', 'B'] as const) {
    it(`sends the reporter's own seat when seat ${seat} clicks "I won"`, () => {
      const onAct = vi.fn()
      const v = view({ seat, legalActions: [REPORT_ACTION] })
      render(<ActionBar view={v} onAct={onAct} />)

      fireEvent.click(screen.getByText('I won').closest('button')!)

      expect(onAct).toHaveBeenCalledTimes(1)
      const sent = onAct.mock.calls[0]![0] as Extract<
        PlayerActionPayload,
        { type: 'REPORT_RESULT' }
      >
      expect(sent.outcome).toBe(seat)
      expect(sent.reportedBy).toBe(seat)
    })

    it(`shows "You won" back to seat ${seat} after it reported itself`, () => {
      const v = view({
        seat,
        rounds: [
          {
            index: 0,
            result: seat,
            selection: { A: null, B: null },
            privilegeHolder: null,
            turnOrderHolder: null,
          },
        ] as never,
      })
      render(<RoundStrip view={v} />)
      expect(screen.getByText('You won')).toBeTruthy()
    })
  }
})

/**
 * The reported bug.
 *
 * The engine offers `['A', 'B', 'TIE']`, so rendering in that order put "I won" first for seat A
 * and second for seat B — the same position meaning opposite things depending on where you sat.
 * Nothing about the payload was wrong, which is why it survived: every seat-to-outcome mapping in
 * the app is correct, and the mistake was made by the person clicking.
 */
describe('button order', () => {
  const order = (seat: 'A' | 'B'): string[] => {
    cleanup()
    render(<ActionBar view={view({ seat, legalActions: [REPORT_ACTION] })} onAct={() => {}} />)
    return screen
      .getAllByRole('button')
      .map((b) => b.querySelector('.btn__label')?.textContent ?? '')
  }

  it('reads the same from both seats', () => {
    expect(order('A')).toEqual(order('B'))
  })

  it('puts your own win first, then theirs, then the tie', () => {
    // Spelled out rather than compared to the other seat: two seats agreeing on the wrong order
    // would pass the test above.
    expect(order('A')).toEqual(['I won', 'They won', 'A tie'])
    expect(order('B')).toEqual(['I won', 'They won', 'A tie'])
  })
})
