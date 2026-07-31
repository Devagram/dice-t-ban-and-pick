import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DraftPanel } from '../src/components/DraftPanel.js'
import { ROSTER, view } from './fixtures.js'
import type { Action } from '@banpick/types'

/**
 * Progress reporting must be **quiet**.
 *
 * The bug this pins: `onProgress` was called from an effect that listed the callback itself in
 * its dependency array, and the callback was rebuilt on every render of `Match`. So the effect
 * fired on every render rather than on every change — and since a progress ping makes the
 * *opponent* re-render, the two clients drove each other:
 *
 *   A picks -> A pings -> B re-renders -> B pings -> A re-renders -> A pings -> ...
 *
 * That is an unbounded loop between two browsers, and the only thing that stopped it was the
 * server's rate limiter, which then locked the seat out of *real* actions with
 * "too many actions; slow down". A cosmetic feature took the match down with it.
 */

const COMMIT: Extract<Action, { type: 'COMMIT' }> = {
  type: 'COMMIT',
  moduleId: 'draft',
  picks: {
    count: 2,
    poolBySlot: [
      ['anvil', 'cartographer', 'duelist'],
      ['anvil', 'cartographer', 'duelist'],
    ],
  },
  metaBan: null,
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

const pick = (name: string) => fireEvent.click(screen.getByText(name))

describe('progress is reported on change, not on render', () => {
  it('does not re-report when the parent re-renders with the same draft', () => {
    const onProgress = vi.fn()
    const props = { view: view(), commit: COMMIT, onAct: vi.fn(), onProgress }

    const { rerender } = render(<DraftPanel {...props} />)
    const afterMount = onProgress.mock.calls.length

    // An unrelated frame arrives — the opponent moved, the connection banner changed, anything.
    // Nothing about *our* draft changed, so nothing should go out.
    for (let i = 0; i < 5; i++) rerender(<DraftPanel {...props} />)

    expect(onProgress.mock.calls.length).toBe(afterMount)
  })

  it('does not re-report when the callback identity changes', () => {
    // This is the actual failure. `Match` passes an inline arrow, so every render produces a new
    // function; an effect keyed on it fires every time regardless of the counts.
    const calls: [number, number][] = []
    const render1 = () =>
      render(
        <DraftPanel
          view={view()}
          commit={COMMIT}
          onAct={vi.fn()}
          onProgress={(f, o) => calls.push([f, o])}
        />,
      )

    const { rerender } = render1()
    const afterMount = calls.length

    for (let i = 0; i < 5; i++) {
      rerender(
        <DraftPanel
          view={view()}
          commit={COMMIT}
          onAct={vi.fn()}
          onProgress={(f, o) => calls.push([f, o])}
        />,
      )
    }

    expect(calls.length).toBe(afterMount)
  })

  it('does report when a pick is actually made', () => {
    const onProgress = vi.fn()
    render(<DraftPanel view={view()} commit={COMMIT} onAct={vi.fn()} onProgress={onProgress} />)

    onProgress.mockClear()
    pick(ROSTER.find((c) => c.id === 'anvil')!.name)
    expect(onProgress).toHaveBeenCalledWith(1, 2, false)

    onProgress.mockClear()
    pick(ROSTER.find((c) => c.id === 'cartographer')!.name)
    expect(onProgress).toHaveBeenCalledWith(2, 2, false)
  })

  it('sends at most one report per decision over a whole draft', () => {
    // The budget matters: the server's token bucket refills at 4/second, and a draft of four
    // picks plus a ban should cost five messages, not fifty.
    const onProgress = vi.fn()
    render(<DraftPanel view={view()} commit={COMMIT} onAct={vi.fn()} onProgress={onProgress} />)

    pick(ROSTER.find((c) => c.id === 'anvil')!.name)
    pick(ROSTER.find((c) => c.id === 'cartographer')!.name)

    // One for the initial 0-of-2, then one per pick.
    expect(onProgress.mock.calls.length).toBeLessThanOrEqual(3)
  })
})
