import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { PlayerActionPayload } from '@banpick/types'

import { ActionBar, slotTargets } from '../src/components/ActionBar.js'
import { SlotRail } from '../src/components/SlotRail.js'
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

describe('slot choices come from the server too', () => {
  it('marks selectable only the slots a SELECT offered', () => {
    const v = view({ legalActions: [SELECT_ACTION] })
    const targets = slotTargets(v)
    expect(targets.own).toEqual([1, 3])
    expect(targets.opponent).toEqual([])

    render(
      <SlotRail
        title="Yours"
        view={v.you}
        roster={ROSTER}
        currentRound={0}
        selectable={targets.own as (0 | 1 | 2 | 3)[]}
        onSelect={vi.fn()}
      />,
    )

    // Slots 0 and 2 are not offered, so they are not pressable — the server said so, and the
    // client did not work out why.
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => (b as HTMLButtonElement).disabled)).toEqual([
      true,
      false,
      true,
      false,
    ])
  })

  it('marks bannable only the opponent slots a BAN offered', () => {
    const v = view({ legalActions: [BAN_ACTION] })
    const targets = slotTargets(v)
    expect(targets.opponent).toEqual([0, 2])
    expect(targets.own).toEqual([])
  })

  it('offers nothing on either rail when neither action is present', () => {
    const targets = slotTargets(view({ legalActions: [CHOOSE_PRIVILEGE] }))
    expect(targets.own).toEqual([])
    expect(targets.opponent).toEqual([])
  })
})

describe('§7 redaction is rendered, not reconstructed', () => {
  it('shows a sealed rail when the opponent slice is absent', () => {
    render(<SlotRail title="Theirs" view={sealedOpponent()} roster={ROSTER} currentRound={0} />)

    // Four sealed placeholders — the count is public (it is `draftCount`), the contents are not.
    expect(screen.getAllByText('Sealed')).toHaveLength(4)
    // And nothing of the opponent's is on screen, because nothing of theirs arrived.
    for (const character of ROSTER) {
      expect(screen.queryByText(character.name)).toBeNull()
    }
  })

  it('shows the commitment exists even while its contents do not', () => {
    render(<SlotRail title="Theirs" view={sealedOpponent()} roster={ROSTER} currentRound={0} />)
    // §12: the seal hides the contents, not the fact. Otherwise "waiting for opponent" is
    // unrenderable and the UI has to guess.
    expect(screen.getByText(/cannot be changed or taken back/)).toBeTruthy()
  })
})

describe('slot states read differently at a glance', () => {
  it('distinguishes played, banned-this-round, and available', () => {
    const v = view({
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 4,
        slots: [
          slot(0, 'anvil', { consumed: true }),
          slot(1, 'cartographer', { bannedInRound: 0 }),
          slot(2, 'duelist'),
          // Banned in an *earlier* round: D3 makes a round ban round-scoped, so it is available
          // again and must not read as denied.
          slot(3, 'gambler', { bannedInRound: 0 }),
        ],
      },
    })

    render(<SlotRail title="Yours" view={v.you} roster={ROSTER} currentRound={1} />)

    expect(screen.getByLabelText('The Anvil — played')).toBeTruthy()
    expect(screen.getByLabelText('The Cartographer — available')).toBeTruthy()
    expect(screen.getByLabelText('The Gambler — available')).toBeTruthy()
  })

  it('marks a slot banned only during the round it was banned in', () => {
    const v = view({
      you: {
        seat: 'A',
        score: 0,
        hasCommitted: true,
        slotCount: 1,
        slots: [slot(0, 'anvil', { bannedInRound: 1 })],
      },
    })

    const { rerender } = render(
      <SlotRail title="Yours" view={v.you} roster={ROSTER} currentRound={1} />,
    )
    expect(screen.getByLabelText('The Anvil — banned this round')).toBeTruthy()

    rerender(<SlotRail title="Yours" view={v.you} roster={ROSTER} currentRound={2} />)
    expect(screen.getByLabelText('The Anvil — available')).toBeTruthy()
  })
})
