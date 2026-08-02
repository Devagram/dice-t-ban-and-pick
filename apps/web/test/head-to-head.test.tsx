import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { HeadToHead } from '../src/components/HeadToHead.js'
import { view } from './fixtures.js'

/**
 * D29 — the record against the person opposite you.
 *
 * `wins` from the endpoint is always wins for the id asked about *first*, so this asks about you
 * and reads the answer directly. That is what keeps A's "3–2 up" and B's "2–3 down" from drifting:
 * they are one stored row read twice, not two rows kept in step by hope.
 */

/** A view with both seats named. Stubbing `fetch` is the caller's job — a helper that did it
 *  silently overrode the one test that needed the lookup to fail. */
const namedView = () =>
  view({
    you: {
      seat: 'A',
      score: 0,
      hasCommitted: false,
      slotCount: 0,
      player: { id: 'p-a', name: 'Tom' },
    },
    opponent: {
      seat: 'B',
      score: 0,
      hasCommitted: false,
      slotCount: 0,
      player: { id: 'p-b', name: 'Alex' },
    },
  })

const named = (record: { wins: number; losses: number; draws: number }) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ...record, matches: [] }))),
  )
  return namedView()
}

beforeEach(cleanup)
afterEach(() => vi.unstubAllGlobals())

describe('the head-to-head reads from your side', () => {
  it('says you lead when you are ahead', async () => {
    render(<HeadToHead view={named({ wins: 3, losses: 2, draws: 0 })} />)
    await waitFor(() => expect(screen.getByText('You lead Alex')).toBeTruthy())
    expect(screen.getByText('3–2')).toBeTruthy()
  })

  it('names them when they are ahead', async () => {
    render(<HeadToHead view={named({ wins: 1, losses: 4, draws: 0 })} />)
    await waitFor(() => expect(screen.getByText('Alex leads you')).toBeTruthy())
  })

  it('calls it level when it is level', async () => {
    render(<HeadToHead view={named({ wins: 2, losses: 2, draws: 1 })} />)
    await waitFor(() => expect(screen.getByText('Level with Alex')).toBeTruthy())
    // Draws are shown, not folded into the record — D21 makes them real.
    expect(screen.getByText(/\(1D\)/)).toBeTruthy()
  })

  it('says nothing before the two of you have played', async () => {
    const { container } = render(<HeadToHead view={named({ wins: 0, losses: 0, draws: 0 })} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })

  it('says nothing when either seat is anonymous, and does not even ask', () => {
    // A record against "Unnamed" is a record against nobody — and there is no id to ask with.
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const anonymous = view({
      you: { seat: 'A', score: 0, hasCommitted: false, slotCount: 0 },
      opponent: { seat: 'B', score: 0, hasCommitted: false, slotCount: 0 },
    })
    const { container } = render(<HeadToHead view={anonymous} />)
    expect(container.innerHTML).toBe('')
    expect(spy).not.toHaveBeenCalled()
  })

  it('stays quiet when the lookup fails', async () => {
    // A missing record is not worth an error banner on a match screen.
    const v = namedView()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    const { container } = render(<HeadToHead view={v} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })
})
