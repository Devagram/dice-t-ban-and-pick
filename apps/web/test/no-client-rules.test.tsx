import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PlayerActionPayload, PlayerView } from '@banpick/types'

import { ActionBar, slotTargets } from '../src/components/ActionBar.js'
import { Stage } from '../src/components/Stage.js'
import {
  BAN_ACTION,
  CHOOSE_ORDER,
  CHOOSE_PRIVILEGE,
  REPORT_ACTION,
  ROSTER,
  SELECT_ACTION,
  sealedOpponent,
  slot,
  view,
} from './fixtures.js'

/**
 * **The Phase 4 exit criterion: "Disabling JavaScript-side validation entirely changes nothing
 * about which actions succeed."**
 *
 * There is no JavaScript-side validation to disable, and these tests are how that claim is
 * kept true rather than merely asserted. Every control on screen is a rendering of something in
 * `legalActions`; remove an entry and the control goes with it; add one and it appears. The
 * client has no rule that could disagree with the server, because it has no rules.
 */

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

describe('controls appear only when the server offers them', () => {
  it('renders nothing when legalActions is empty', () => {
    const { container } = render(<ActionBar view={view({ legalActions: [] })} onAct={vi.fn()} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('renders the privilege choice only when a CHOOSE is offered', () => {
    render(<ActionBar view={view({ legalActions: [CHOOSE_PRIVILEGE] })} onAct={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Draft privilege/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Turn order/ })).toBeTruthy()
  })

  it('offers exactly the options the server listed, never more', () => {
    // A narrowed CHOOSE — D11 removed round 2's rather than narrowing it, but the client must
    // not care *why* a list is short. It renders what arrived.
    render(
      <ActionBar
        view={view({ legalActions: [{ ...CHOOSE_PRIVILEGE, options: ['TURN_ORDER'] }] })}
        onAct={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Draft privilege/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Turn order/ })).toBeTruthy()
  })

  it('renders result options exactly as offered, including a mode with no tie', () => {
    render(
      <ActionBar
        view={view({ legalActions: [{ ...REPORT_ACTION, outcomes: ['A', 'B'] }] })}
        onAct={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /A tie/ })).toBeNull()
    expect(screen.getByRole('button', { name: /I won/ })).toBeTruthy()
  })

  it('shows the undo whenever the server offers it, and never otherwise', () => {
    const { rerender } = render(<ActionBar view={view({ legalActions: [] })} onAct={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()

    rerender(
      <ActionBar
        view={view({ legalActions: [{ type: 'UNDO_LAST_RESULT', moduleId: null, roundIndex: 1 }] })}
        onAct={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Undo round 2/ })).toBeTruthy()
  })
})

describe('the payload posted is built from the offered action', () => {
  it('sends the module id and round the server named, not one it worked out', () => {
    const onAct = vi.fn<(p: PlayerActionPayload) => void>()
    render(<ActionBar view={view({ legalActions: [CHOOSE_ORDER] })} onAct={onAct} />)

    screen.getByRole('button', { name: /I play first/ }).click()

    expect(onAct).toHaveBeenCalledWith({
      type: 'CHOOSE',
      moduleId: 'rounds.0.declareOrder',
      roundIndex: 0,
      seat: 'A',
      option: 'SELF_FIRST',
    })
  })

  it('reports the outcome under the reporting seat, whoever that is', () => {
    const onAct = vi.fn<(p: PlayerActionPayload) => void>()
    render(<ActionBar view={view({ seat: 'B', legalActions: [REPORT_ACTION] })} onAct={onAct} />)

    screen.getByRole('button', { name: /I won/ }).click()

    // D15 — either seat may report. "I won" from seat B is outcome B.
    expect(onAct).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REPORT_RESULT', reportedBy: 'B', outcome: 'B' }),
    )
  })
})

/**
 * The same assertions, against the board that replaced `SlotRail`.
 *
 * These are D18 tests, not layout tests: what a player can press comes from `legalActions` and
 * nothing else. They were written against the old vertical rail; the component changed, the
 * guarantee did not, so they moved rather than being deleted with it.
 */
const board = (v: PlayerView, targets: ReturnType<typeof slotTargets>) => (
  <Stage
    view={v}
    expected={4}
    mine={{ filled: 0 }}
    theirs={{ filled: 0 }}
    selectableOwn={targets.own as (0 | 1 | 2 | 3)[]}
    selectableOpponent={targets.opponent as (0 | 1 | 2 | 3)[]}
    onSelectOwn={vi.fn()}
    onSelectOpponent={vi.fn()}
  />
)

describe('slot choices come from the server too', () => {
  it('makes pressable only the slots a SELECT offered', () => {
    const v = view({ legalActions: [SELECT_ACTION] })
    const targets = slotTargets(v)
    expect(targets.own).toEqual([1, 3])
    expect(targets.opponent).toEqual([])

    const { container } = render(board(v, targets))

    // Slots 0 and 2 were not offered, so they are not buttons at all — the server said so, and
    // the client did not work out why.
    const pressable = container.querySelectorAll('.side--own button.cell')
    expect(pressable).toHaveLength(2)
    expect([...pressable].map((b) => b.getAttribute('aria-label'))).toEqual([
      'The Cartographer',
      'The Gambler',
    ])
  })

  it('marks bannable only the opponent slots a BAN offered', () => {
    const v = view({ legalActions: [BAN_ACTION] })
    const targets = slotTargets(v)
    expect(targets.opponent).toEqual([0, 2])
    expect(targets.own).toEqual([])
  })

  it('offers nothing on either side when neither action is present', () => {
    const v = view({ legalActions: [CHOOSE_PRIVILEGE] })
    const targets = slotTargets(v)
    expect(targets.own).toEqual([])
    expect(targets.opponent).toEqual([])

    const { container } = render(board(v, targets))
    expect(container.querySelectorAll('button.cell')).toHaveLength(0)
  })
})

describe('§7 redaction is rendered, not reconstructed', () => {
  it('shows sealed placeholders when the opponent slice is absent', () => {
    const v = view({ opponent: sealedOpponent() })
    render(<Stage view={v} expected={4} mine={{ filled: 0 }} theirs={{ filled: 0 }} />)

    // Four sealed boxes — the count is public (it is `draftCount`), the contents are not.
    expect(screen.getAllByText('Sealed')).toHaveLength(4)
    // Scoped to their side: your own board legitimately names your own characters.
    const theirs = document.querySelector('.side--opponent')!
    for (const character of ROSTER) {
      expect(theirs.textContent).not.toContain(character.name)
    }
  })
})

describe('slot states read differently at a glance', () => {
  const played = (currentRound: 0 | 1 | 2, slots: ReturnType<typeof slot>[]) =>
    view({
      phase: {
        moduleId: `rounds.${currentRound}.ban`,
        type: 'BAN',
        roundIndex: currentRound,
        awaiting: ['A'],
      },
      you: { seat: 'A', score: 0, hasCommitted: true, slotCount: slots.length, slots },
    })

  it('distinguishes played, banned-this-round, and available', () => {
    const v = played(1, [
      slot(0, 'anvil', { consumed: true }),
      slot(1, 'cartographer', { bannedInRound: 0 }),
      slot(2, 'duelist'),
      // Banned in an *earlier* round: D3 makes a round ban round-scoped, so it is available
      // again and must not read as denied.
      slot(3, 'gambler', { bannedInRound: 0 }),
    ])
    render(<Stage view={v} expected={4} mine={{ filled: 0 }} theirs={{ filled: 0 }} />)

    expect(screen.getByLabelText('The Anvil — played')).toBeTruthy()
    expect(screen.getByLabelText('The Cartographer')).toBeTruthy()
    expect(screen.getByLabelText('The Gambler')).toBeTruthy()
  })

  it('marks a slot banned only during the round it was banned in', () => {
    const { rerender } = render(
      <Stage
        view={played(1, [slot(0, 'anvil', { bannedInRound: 1 })])}
        expected={1}
        mine={{ filled: 0 }}
        theirs={{ filled: 0 }}
      />,
    )
    expect(screen.getByLabelText('The Anvil — banned this round')).toBeTruthy()

    rerender(
      <Stage
        view={played(2, [slot(0, 'anvil', { bannedInRound: 1 })])}
        expected={1}
        mine={{ filled: 0 }}
        theirs={{ filled: 0 }}
      />,
    )
    expect(screen.getByLabelText('The Anvil')).toBeTruthy()
  })
})
