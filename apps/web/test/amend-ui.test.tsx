import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Action, PlayerActionPayload } from '@banpick/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RoundStrip } from '../src/components/RoundStrip.js'
import { view } from './fixtures.js'

afterEach(cleanup)

const AMEND: Extract<Action, { type: 'AMEND_RESULT' }> = {
  type: 'AMEND_RESULT',
  moduleId: null,
  rounds: [
    { roundIndex: 0, current: 'A', outcomes: ['A', 'B', 'TIE'] },
    { roundIndex: 1, current: 'B', outcomes: ['A', 'B'] },
  ],
}

const played = (over: Partial<Parameters<typeof view>[0]> = {}) =>
  view({
    status: 'COMPLETE',
    outcome: 'A',
    legalActions: [AMEND],
    rounds: [
      { index: 0, result: 'A' },
      { index: 1, result: 'B' },
    ].map((r) => ({
      ...r,
      privilegeHolder: null,
      turnOrderHolder: null,
      roll: null,
      ban: null,
      selection: {},
      selectionCommitted: { A: true, B: true },
      playOrder: null,
      overtime: false,
    })) as never,
    ...over,
  })

describe('correcting a round from the strip', () => {
  it('sends the round and the outcome that was picked', () => {
    const onAct = vi.fn()
    const v = played()
    render(<RoundStrip view={v} onAct={onAct} />)

    // Round 0 reads as the viewer's win, so the control to change it is that label.
    fireEvent.click(screen.getAllByRole('button')[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'They won' }))

    const sent = onAct.mock.calls[0]![0] as Extract<PlayerActionPayload, { type: 'AMEND_RESULT' }>
    expect(sent).toMatchObject({
      type: 'AMEND_RESULT',
      roundIndex: 0,
      outcome: v.seat === 'A' ? 'B' : 'A',
      amendedBy: v.seat,
    })
  })

  it('offers a round only the outcomes that round accepts', () => {
    render(<RoundStrip view={played()} onAct={() => {}} />)

    // Round 1 is the one whose action carries only A and B — the client must not invent the
    // tie for it, because deciding that is a rule (§11 non-negotiable 4).
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(screen.queryByRole('button', { name: 'Tie' })).toBeNull()
    expect(screen.getByRole('button', { name: 'I won' })).toBeTruthy()
  })

  it('orders the choices the same way the live report does', () => {
    render(<RoundStrip view={played()} onAct={() => {}} />)
    fireEvent.click(screen.getAllByRole('button')[0]!)

    /*
     * D32's fix, applied here too: your own win first, then theirs, then the tie. Someone
     * correcting a misreport should not be handed a second chance to make the same one because
     * the buttons sit in a different order than they did a minute ago.
     */
    const labels = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => t === 'I won' || t === 'They won' || t === 'Tie')
    expect(labels).toEqual(['I won', 'They won', 'Tie'])
  })

  it('can be backed out of without changing anything', () => {
    const onAct = vi.fn()
    render(<RoundStrip view={played()} onAct={onAct} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onAct).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('is plain text where there is no way to act', () => {
    // The strip renders without `onAct` too, and a button that cannot do anything is worse
    // than the text it replaced.
    render(<RoundStrip view={played()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('You won')).toBeTruthy()
  })

  it('offers nothing for a round the server did not list', () => {
    // Round 1 dropped from the action: a result exists, but correcting it is not on offer.
    const v = played({ legalActions: [{ ...AMEND, rounds: [AMEND.rounds[0]!] }] } as never)
    render(<RoundStrip view={v} onAct={() => {}} />)

    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
