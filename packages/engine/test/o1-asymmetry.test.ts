import { describe, expect, it } from 'vitest'
import { baseMode, slotPool } from '@banpick/engine'
import type { MatchState, Seat } from '@banpick/types'

import { apply, atModule, currentAction, driveUntil, otherSeat, startMatch } from './helpers.js'

/**
 * Phase 1 gate — **O1 asymmetry (§14.1).**
 *
 * "An explicit test encoding the current round-1 privilege strength, written so that a future
 * balance fix visibly changes its expected value."
 *
 * O1 is a *balance* claim — that round-1 privilege is stronger than round-0's — and balance is
 * settled by §15's win-rate data, not by a unit test. What a unit test can pin is the
 * **mechanical fact underneath the claim**: how many options the ban leaves the opponent.
 * §9.3's table states them, and they are what a balance change would have to move:
 *
 * |    | draftCount 3          | draftCount 4              |
 * |----|-----------------------|---------------------------|
 * | R0 | ban leaves **2**      | ban leaves **3**          |
 * | R1 | ban leaves **1** (forced) | ban leaves **2**      |
 * | R2 | 1 each, no ban (forced)   | 2 each, no ban        |
 *
 * If a future change moves a number here, this test fails and someone has to say so out loud.
 * That is the whole point of it existing.
 */

interface Reading {
  optionsAfterBan: number
  forced: boolean
}

/** Plays to round `n`'s ban, places it, and reports what the victim is left with. */
function readBan(draftCount: 3 | 4, roundIndex: 0 | 1): Reading {
  let state: MatchState = startMatch({ mode: baseMode, draftCount })
  state = driveUntil(state, atModule(`rounds.${roundIndex}.ban`))

  const banner = state.rounds[roundIndex]!.privilegeHolder!
  const victim: Seat = otherSeat(banner)

  const ban = currentAction(state, banner, 'BAN')!
  state = apply(state, banner, {
    type: 'BAN',
    moduleId: ban.moduleId,
    roundIndex,
    seat: banner,
    tier: 'ROUND',
    target: ban.targets[0]!,
  })

  // Read the pool rather than the offered action, because select *order* differs by round:
  // R1's override hands the privilege holder the first pick, so the victim is not being asked
  // yet at this instant. The pool is the order-independent quantity §9.3's table states, and
  // the banner's own pick cannot change it — it draws from the other seat's slots.
  const optionsAfterBan = slotPool('legalRoundPick', {
    state,
    seat: victim,
    slotIndex: null,
    roundIndex,
  }).length

  // D26 auto-commits a one-option select as SYSTEM, so playing the round out is how we confirm
  // that "one option" really did mean "no decision was ever put to the player".
  const played = driveUntil(state, atModule(`rounds.${roundIndex}.report`))
  const forced = played.log.some(
    (e) =>
      e.payload.type === 'SELECT' &&
      e.payload.reason === 'FORCED' &&
      e.payload.roundIndex === roundIndex &&
      e.payload.seat === victim,
  )

  return { optionsAfterBan, forced }
}

describe('O1 — round-1 privilege strength, at draftCount 3', () => {
  it('leaves the opponent 2 options in round 0 — a real choice', () => {
    expect(readBan(3, 0)).toEqual({ optionsAfterBan: 2, forced: false })
  })

  it('leaves the opponent 1 option in round 1 — the privilege is *total*', () => {
    // G9's sharpening of O1: the round-1 holder does not merely have an advantage, they
    // dictate the matchup with perfect information. Two of three rounds contain no drafting
    // decision at this parameter value, which §9.3 calls a larger problem than the balance one.
    expect(readBan(3, 1)).toEqual({ optionsAfterBan: 1, forced: true })
  })
})

describe('O1 — round-1 privilege strength, at draftCount 4', () => {
  it('leaves the opponent 3 options in round 0', () => {
    expect(readBan(4, 0)).toEqual({ optionsAfterBan: 3, forced: false })
  })

  it('leaves the opponent 2 options in round 1 — strong, no longer total', () => {
    // §9.3: four slots does not eliminate the asymmetry, it *narrows* it. That is the claim
    // this number encodes, and it is the number a balance fix would move.
    expect(readBan(4, 1)).toEqual({ optionsAfterBan: 2, forced: false })
  })

  it('keeps R1 stronger than R0 — the asymmetry is narrowed, not removed', () => {
    expect(readBan(4, 1).optionsAfterBan).toBeLessThan(readBan(4, 0).optionsAfterBan)
  })
})

describe('the §9.3 counterweight', () => {
  it('hands the opponent the last pick in round 1, and the privilege holder it in round 0', () => {
    // R1's selectOrder override is deliberate compensation for R1's stronger ban: the
    // *opponent* picks second, with full information. At draftCount 3 the opponent is forced
    // and the counterweight is dead on arrival; at 4 it does the job it was written to do.
    const program = startMatch({ mode: baseMode, draftCount: 4 }).mode.program
    const selects = (round: number) =>
      program.filter((m) => m.type === 'SELECT' && m.roundIndex === round)

    expect(selects(0).map((m) => (m as { actor: string }).actor)).toEqual([
      'opponent',
      'privilegeHolder',
    ])
    expect(selects(1).map((m) => (m as { actor: string }).actor)).toEqual([
      'privilegeHolder',
      'opponent',
    ])
    // R2 has no privilege at all, so both pick at once and neither holds information.
    expect(selects(2)).toHaveLength(1)
    expect((selects(2)[0] as { mode: string }).mode).toBe('SIMULTANEOUS_HIDDEN')
  })
})
