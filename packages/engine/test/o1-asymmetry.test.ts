import { describe, expect, it } from 'vitest'
import { baseMode } from '@banpick/engine'
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

  /*
   * Counted *before* the ban is applied, and by arithmetic rather than by reading the pool
   * afterwards.
   *
   * `apply` drains the system step, and since 2026-07-31 the banned seat picks first — so at
   * draftCount 3 the ban leaves it exactly one option and D26 auto-commits that option inside the
   * same call. Reading the pool after the ban therefore measures zero, not because the victim had
   * no choice but because the choice was already taken for it. The quantity §9.3 states is "how
   * many did the ban leave", which is a fact about the moment of the ban.
   */
  const ban = currentAction(state, banner, 'BAN')!
  const unconsumedBefore = state.seats[victim].slots.value.filter((s) => !s.consumed)
  const optionsAfterBan = unconsumedBefore.filter(
    (s) => s.index !== ban.targets[0]!.slotIndex,
  ).length

  state = apply(state, banner, {
    type: 'BAN',
    moduleId: ban.moduleId,
    roundIndex,
    seat: banner,
    tier: 'ROUND',
    target: ban.targets[0]!,
  })

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

describe('the ban is answered before it is exploited', () => {
  it('gives the banned seat the first pick in every round that has a ban', () => {
    /*
     * **§9.3's counterweight was removed on 2026-07-31.**
     *
     * Round 1 used to invert the select order so the *banner* chose first, as compensation for
     * round 1's stronger ban. It was dropped after play: the rule a table expects is the simple
     * one — you ban, they answer, you counter-pick — and reversing it in the middle round read as
     * a bug rather than as balance. A counterweight nobody can feel is not balancing anything.
     *
     * Asserted on both rounds together, because the point is that they now agree.
     */
    const program = startMatch({ mode: baseMode, draftCount: 4 }).mode.program
    const selects = (round: number) =>
      program.filter((m) => m.type === 'SELECT' && m.roundIndex === round)

    for (const round of [0, 1]) {
      expect(selects(round).map((m) => (m as { actor: string }).actor)).toEqual([
        'opponent',
        'privilegeHolder',
      ])
    }
    // R2 has no privilege at all, so both pick at once and neither holds information.
    expect(selects(2)).toHaveLength(1)
    expect((selects(2)[0] as { mode: string }).mode).toBe('SIMULTANEOUS_HIDDEN')
  })
})
