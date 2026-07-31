import { describe, expect, it, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Action } from '@banpick/types'

import { DraftPanel } from '../src/components/DraftPanel.js'
import { ROSTER, view } from './fixtures.js'

/**
 * One panel, two commit phases.
 *
 * `bring-ban1` now asks for a **ban** and then a **draft**, as two separate
 * `SIMULTANEOUS_COMMIT` modules. React reconciles by position, so the same `DraftPanel` instance
 * serves both — and anything it holds in state survives the transition. The draft module declares
 * no meta ban, so a ban left over from the previous phase is rejected as `WRONG_COMMIT_SHAPE`
 * ("draft declares no meta ban") and the player is simply stuck.
 */

const BAN_PHASE: Extract<Action, { type: 'COMMIT' }> = {
  type: 'COMMIT',
  moduleId: 'ban',
  picks: null,
  metaBan: { count: 1, pool: ['anvil', 'cartographer', 'duelist'] },
}

const DRAFT_PHASE: Extract<Action, { type: 'COMMIT' }> = {
  type: 'COMMIT',
  moduleId: 'draft',
  picks: {
    count: 2,
    poolBySlot: [
      ['gambler', 'herald', 'magpie'],
      ['gambler', 'herald', 'magpie'],
    ],
  },
  metaBan: null,
}

const nameOf = (id: string) => ROSTER.find((c) => c.id === id)!.name

beforeEach(() => {
  cleanup()
  localStorage.clear()
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }))
})

describe('a commit carries only what its own module asked for', () => {
  it('does not send the previous phase’s ban along with the draft', () => {
    const onAct = vi.fn()
    const { rerender } = render(<DraftPanel view={view()} commit={BAN_PHASE} onAct={onAct} />)

    // Phase one: choose and seal a ban.
    fireEvent.click(screen.getByText(nameOf('anvil')))
    fireEvent.click(screen.getByText('Seal and commit'))
    expect(onAct).toHaveBeenLastCalledWith(expect.objectContaining({ metaBan: 'anvil' }))

    // Phase two arrives in the same component instance.
    onAct.mockClear()
    rerender(<DraftPanel view={view()} commit={DRAFT_PHASE} onAct={onAct} />)

    fireEvent.click(screen.getByText(nameOf('gambler')))
    fireEvent.click(screen.getByText(nameOf('herald')))
    fireEvent.click(screen.getByText('Seal and commit'))

    const sent = onAct.mock.calls.at(-1)![0] as { moduleId: string; metaBan: string | null }
    expect(sent.moduleId).toBe('draft')
    // The engine rejects a ban the module never declared: "draft declares no meta ban".
    expect(sent.metaBan).toBeNull()
  })

  it('does not send the previous phase’s picks along with a ban-only commit', () => {
    const onAct = vi.fn()
    const { rerender } = render(<DraftPanel view={view()} commit={DRAFT_PHASE} onAct={onAct} />)
    fireEvent.click(screen.getByText(nameOf('gambler')))
    fireEvent.click(screen.getByText(nameOf('herald')))
    fireEvent.click(screen.getByText('Seal and commit'))

    onAct.mockClear()
    rerender(<DraftPanel view={view()} commit={BAN_PHASE} onAct={onAct} />)
    fireEvent.click(screen.getByText(nameOf('anvil')))
    fireEvent.click(screen.getByText('Seal and commit'))

    const sent = onAct.mock.calls.at(-1)![0] as { moduleId: string; picks: string[] }
    expect(sent.moduleId).toBe('ban')
    expect(sent.picks).toEqual([])
  })
})
