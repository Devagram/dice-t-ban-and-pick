import { describe, expect, it } from 'vitest'
import { baseMode, legalActions } from '@banpick/engine'
import type { MatchState, Seat } from '@banpick/types'

import { apply, currentAction, playMatch, startMatch } from './helpers.js'

/**
 * Phase 1 gate — **auto-commit (D26).**
 *
 * "Test it at `draftCount: 3`, where it fires in both round 1 and round 2; at `draftCount: 4`
 * it should never fire in the base mode, and a test should assert that too."
 *
 * D26 is the decision that let `draftCount` become a parameter without putting an `if` inside
 * mode config. The rule was never *"round 2 is special"* — it is **"a decision with one option
 * is not a decision"** — so the same program serves both values.
 */

function forcedSelects(state: MatchState) {
  return state.log.filter((e) => e.payload.type === 'SELECT' && e.payload.reason === 'FORCED')
}

describe('auto-commit at draftCount 3', () => {
  it('fires in round 1 and round 2, and only ever as SYSTEM', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), ['A', 'B', 'A'])
    const forced = forcedSelects(final)

    const rounds = new Set(forced.map((e) => (e.payload as { roundIndex: number }).roundIndex))
    // R1: the ban leaves the opponent exactly one option. R2: one slot each, no ban.
    expect(rounds).toContain(1)
    expect(rounds).toContain(2)
    expect(rounds).not.toContain(0) // R0's ban leaves 2, which is a real choice

    for (const e of forced) expect(e.actor).toBe('SYSTEM')
  })

  it('never offers a one-option select as an action', () => {
    // Surfacing a choice with one option is the dominated-action smell D11 removed from round
    // 2. The system commits it instead; the player is never asked.
    const state = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), ['A', 'B', 'A'])
    for (const e of state.log) {
      if (e.payload.type !== 'SELECT') continue
      expect(e.payload.reason === 'FORCED' || e.actor !== 'SYSTEM').toBe(true)
    }
  })

  it('still appends an event, so `consumed` moves and the replay is complete (D13)', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 3 }), ['A', 'B', 'A'])
    for (const seat of ['A', 'B'] as const) {
      expect(final.seats[seat].slots.value.every((s) => s.consumed)).toBe(true)
    }
    // Three selects per seat, whoever authored them.
    for (const seat of ['A', 'B'] as const) {
      const selects = final.log.filter(
        (e) => e.payload.type === 'SELECT' && e.payload.seat === seat,
      )
      expect(selects).toHaveLength(3)
    }
  })
})

describe('auto-commit at draftCount 4', () => {
  it('never fires in the base mode', () => {
    // §9.3's argument, mechanically: at four slots every round contains a real drafting
    // decision. If this test ever starts failing, the pick phase has stopped mattering
    // somewhere and that is a design finding, not a test to update.
    for (const results of [
      ['A', 'B', 'A'],
      ['B', 'A', 'TIE'],
      ['TIE', 'TIE', 'TIE'],
    ] as const) {
      const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), [...results])
      expect(forcedSelects(final), `results ${results.join('/')}`).toHaveLength(0)
    }
  })

  it('offers a real select to both seats in round 2', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = driveToRound2Select(state)

    for (const seat of ['A', 'B'] as const) {
      const action = currentAction(state, seat, 'SELECT')
      expect(action, `seat ${seat} should face a real round-2 choice`).not.toBeNull()
      // Two unconsumed slots each, no ban, no information advantage either way.
      expect(action!.slots).toHaveLength(2)
    }
  })
})

/** Plays to round 2's select with a 1-1 split so `stopWhenDecided` does not end things early. */
function driveToRound2Select(state: MatchState): MatchState {
  const results: Record<number, 'A' | 'B'> = { 0: 'A', 1: 'B' }
  let current = state

  for (let guard = 0; guard < 100; guard++) {
    if (current.mode.program[current.cursor]?.id === 'rounds.2.select') return current

    const actor = (['A', 'B'] as Seat[]).find((s) =>
      legalActions(current, s).some((a) => a.type !== 'UNDO_LAST_RESULT'),
    )
    if (!actor) throw new Error('driveToRound2Select: nobody can act')

    const action = legalActions(current, actor).find((a) => a.type !== 'UNDO_LAST_RESULT')!
    switch (action.type) {
      case 'COMMIT':
        current = apply(current, actor, {
          type: 'COMMIT',
          moduleId: action.moduleId,
          seat: actor,
          picks: action.picks!.poolBySlot.map((pool, i) => pool[i]!),
          metaBan: null,
        })
        break
      case 'CHOOSE':
        current = apply(current, actor, {
          type: 'CHOOSE',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
          option: action.options[0]!,
        })
        break
      case 'BAN':
        current = apply(current, actor, {
          type: 'BAN',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
          tier: 'ROUND',
          target: action.targets[0]!,
        })
        break
      case 'SELECT':
        current = apply(current, actor, {
          type: 'SELECT',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
          slotIndex: action.slots[0]!,
          reason: null,
        })
        break
      case 'REPORT_RESULT':
        current = apply(current, actor, {
          type: 'REPORT_RESULT',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          reportedBy: actor,
          outcome: results[action.roundIndex] ?? 'A',
        })
        break
      default:
        throw new Error(`driveToRound2Select: unexpected action ${action.type}`)
    }
  }
  throw new Error('driveToRound2Select: never reached round 2')
}
