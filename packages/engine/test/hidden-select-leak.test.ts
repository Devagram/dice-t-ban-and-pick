import { describe, expect, it } from 'vitest'
import { baseMode, project } from '@banpick/engine'

import { apply, atModule, currentAction, driveUntil, startMatch } from './helpers.js'

/**
 * §7 — round 2's select is hidden, and staying hidden means more than sealing `selection`.
 *
 * Selecting consumes the slot immediately (D6 consumes it even on a tie) and `slots` is public
 * once the draft reveals. Together those leaked the entire point of the round: `selection` was
 * correctly sealed, but the opponent could see *which* of your characters had just become
 * consumed — the same fact by another route. Whoever picked second could read the board.
 *
 * Reported from play, and it had been there since round 2 existed; the board only made it legible
 * by giving position and colour meaning. That is the shape worth remembering — a redaction hole
 * can sit open for as long as nothing draws attention to it.
 */

/** Plays to round 2's simultaneous select, then has A pick and nobody else. */
function aHasPickedSecretly() {
  const state = driveUntil(
    startMatch({ mode: baseMode, draftCount: 4 }),
    atModule('rounds.2.select'),
    ['A', 'B', 'A'],
  )
  const offer = currentAction(state, 'A', 'SELECT')!
  return {
    before: state,
    after: apply(state, 'A', {
      type: 'SELECT',
      moduleId: offer.moduleId,
      roundIndex: 2,
      seat: 'A',
      slotIndex: offer.slots[0]!,
      reason: null,
    }),
    picked: offer.slots[0]!,
  }
}

describe('a hidden pick stays hidden', () => {
  it('does not mark the chosen slot spent in the opponent’s view', () => {
    const { after, picked } = aHasPickedSecretly()
    const forB = project(after, 'B')

    const leaked = forB.opponent.slots!.find((s) => s.index === picked)!
    expect(leaked.consumed, 'B can see which character A just spent').toBe(false)
  })

  it('shows no more spent slots than before the pick', () => {
    // The count is as much of a giveaway as the flag: one extra spent slot with one seat still
    // to move names the picker as surely as naming the character.
    const { before, after } = aHasPickedSecretly()
    const spent = (state: typeof before) =>
      project(state, 'B').opponent.slots!.filter((s) => s.consumed).length
    expect(spent(after)).toBe(spent(before))
  })

  it('still shows you your own pick', () => {
    // The seal is against your opponent, not against you — you must be able to see what you chose.
    const { after, picked } = aHasPickedSecretly()
    const mine = project(after, 'A').you.slots!.find((s) => s.index === picked)!
    expect(mine.consumed).toBe(true)
  })

  it('opens once both have picked', () => {
    const { after } = aHasPickedSecretly()
    const offer = currentAction(after, 'B', 'SELECT')!
    const both = apply(after, 'B', {
      type: 'SELECT',
      moduleId: offer.moduleId,
      roundIndex: 2,
      seat: 'B',
      slotIndex: offer.slots[0]!,
      reason: null,
    })
    expect(project(both, 'B').opponent.slots!.some((s) => s.consumed)).toBe(true)
  })

  it('leaves the public rounds alone', () => {
    // Rounds 0 and 1 select in the open — the second picker is *meant* to see the first pick, and
    // that counter-pick is the mode. Masking there would break the game to fix a different round.
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.1.ban'),
      ['A', 'B', 'A'],
    )
    expect(project(state, 'B').opponent.slots!.some((s) => s.consumed)).toBe(true)
  })
})
