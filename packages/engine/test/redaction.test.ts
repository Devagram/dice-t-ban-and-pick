import { describe, expect, it } from 'vitest'
import { baseMode, bringBan1Mode, project } from '@banpick/engine'
import type { MatchState, PlayerView, Seat } from '@banpick/types'

import { apply, currentAction, playFirstLegal, startMatch, ROSTER_75 } from './helpers.js'

/**
 * Phase 1 gate — **redaction (§7, required).**
 *
 * The spec words the test: *"after gate one fires in `bring-ban1`, assert the serialized
 * outbound payload for seat A contains seat B's meta ban and contains zero of seat B's
 * character IDs."*
 *
 * Taken literally against the whole frame that assertion can never pass, and the reason is
 * worth stating rather than working around: the frame legitimately carries the **public
 * roster** (display data, §16) and **A's own draft pool** (`legalActions`, §11.4), and between
 * them they name every active character in the game. "Zero of B's IDs" is a claim about the
 * regions that describe B — `opponent` and `rounds` — not about the frame's vocabulary.
 *
 * So each assertion serializes the *sealed region* and searches that. It is still a
 * serialized-string test, which is the part that matters: §7 warns that an object test passes
 * while a `toJSON` leaks.
 */

const PICKS_A = ['anvil', 'cartographer', 'duelist', 'gambler']
const PICKS_B = ['herald', 'magpie', 'sentinel', 'tinker']

/** Everything in a frame that purports to describe the opponent. */
function sealedRegion(view: PlayerView): string {
  return JSON.stringify({ opponent: view.opponent, rounds: view.rounds })
}

/**
 * Commits both drafts. `banA` hitting one of B's picks is what holds gate two open — with no
 * repick pending the recommit module completes instantly and both gates fire back to back,
 * which is correct behaviour and useless for observing the gap between them.
 */
function commitBoth(banA: string, banB: string): MatchState {
  let state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
  state = apply(state, 'A', {
    type: 'COMMIT',
    moduleId: 'draft',
    seat: 'A',
    picks: PICKS_A,
    metaBan: banA,
  })
  return apply(state, 'B', {
    type: 'COMMIT',
    moduleId: 'draft',
    seat: 'B',
    picks: PICKS_B,
    metaBan: banB,
  })
}

describe('redaction — after gate one, before gate two', () => {
  // A bans one of B's picks (holds gate two open); B bans a character A does not hold.
  const banA = 'herald'
  const banB = 'vagrant'

  it("gives A B's meta ban and zero of B's character IDs", () => {
    const state = commitBoth(banA, banB)
    expect(state.log.some((e) => e.tag === 'draft:reveal')).toBe(true) // gate one fired
    expect(state.log.some((e) => e.tag === 'pickReveal:reveal')).toBe(false) // gate two has not

    const sealed = sealedRegion(project(state, 'A'))

    expect(sealed).toContain(banB) // B's ban is public at gate one
    for (const id of PICKS_B) {
      expect(sealed, `seat A's frame leaked B's pick "${id}"`).not.toContain(id)
    }
  })

  it('opens B to A once gate two fires', () => {
    let state = commitBoth(banA, banB)
    const repick = currentAction(state, 'B', 'RECOMMIT')!
    state = apply(state, 'B', {
      type: 'RECOMMIT',
      moduleId: repick.moduleId,
      seat: 'B',
      replacements: repick.slots.map((s) => ({ index: s.index, characterId: s.pool[0]! })),
    })

    expect(state.log.some((e) => e.tag === 'pickReveal:reveal')).toBe(true)
    const view = project(state, 'A')
    expect(view.opponent.slots).toBeDefined()
    // Everything B kept is now visible; the banned pick is gone, replaced.
    expect(view.opponent.slots!.map((s) => s.characterId)).toContain('magpie')
    expect(view.opponent.slots!.map((s) => s.characterId)).not.toContain(banA)
  })

  it('omits the field entirely rather than sending null or a flag', () => {
    const view = project(commitBoth(banA, banB), 'A')

    // §7: "The client must never receive a redacted value with a flag; it must receive
    // nothing." Absent, not null — which `exactOptionalPropertyTypes` makes a type error to
    // get wrong, rather than something a reviewer has to notice.
    expect('slots' in view.opponent).toBe(false)
    expect(view.opponent.metaBanPlaced).toBe(banB)
    expect('slots' in view.you).toBe(true)

    expect(sealedRegion(view)).not.toContain('"slots":null')
  })

  it('still reports that the opponent has committed', () => {
    const view = project(commitBoth(banA, banB), 'A')
    // The seal hides the contents, not the fact. Otherwise "waiting for opponent" is
    // unrenderable and the UI has to guess.
    expect(view.opponent.hasCommitted).toBe(true)
    expect(view.opponent.slotCount).toBe(4)
  })
})

describe('redaction — before gate one (negative)', () => {
  it("A's frame contains neither B's ban nor B's picks", () => {
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'B',
      picks: PICKS_B,
      metaBan: 'vagrant',
    })
    // A has not committed, so no gate has fired.
    expect(state.log.some((e) => e.tag === 'draft:reveal')).toBe(false)

    const sealed = sealedRegion(project(state, 'A'))
    for (const id of [...PICKS_B, 'vagrant']) {
      expect(sealed, `seat A's frame leaked "${id}" before any gate`).not.toContain(id)
    }
    expect('metaBanPlaced' in project(state, 'A').opponent).toBe(false)
  })

  it('leaks nothing at the ~75-character target scale either', () => {
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4, roster: ROSTER_75 })
    const offer = currentAction(state, 'B', 'COMMIT')!
    const bPicks = offer.picks!.poolBySlot.map((pool, i) => pool[i * 7]!)
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'B',
      picks: bPicks,
      metaBan: offer.metaBan!.pool[40]!,
    })

    const view = project(state, 'A')
    expect('slots' in view.opponent).toBe(false)
    expect('metaBanPlaced' in view.opponent).toBe(false)
    const sealed = sealedRegion(view)
    for (const id of bPicks) expect(sealed).not.toContain(id)
    // The public roster is intact — redaction hides holdings, not the game's contents.
    expect(view.roster).toHaveLength(75)
  })
})

describe('redaction — round 2 simultaneous hidden select', () => {
  it('hides the opponent selection until both have picked, then opens it', () => {
    // The case that forces §7's per-slice visibility: rounds 0-1 select in public, round 2
    // selects sealed. One phase enum cannot say both things about the same field.
    //
    // Rounds 0 and 1 are split 1-1 so `stopWhenDecided` does not end the match at 2-0 before
    // round 2 is ever played — which it correctly would.
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = advanceToRound2(state)

    const first = (['A', 'B'] as const).find((s) => currentAction(state, s, 'SELECT') !== null)
    expect(first, 'round 2 should be offering a real select at draftCount 4').toBeDefined()
    const other: Seat = first === 'A' ? 'B' : 'A'

    const action = currentAction(state, first!, 'SELECT')!
    state = apply(state, first!, {
      type: 'SELECT',
      moduleId: action.moduleId,
      roundIndex: action.roundIndex,
      seat: first!,
      slotIndex: action.slots[0]!,
      reason: null,
    })

    const mid = project(state, other)
    expect(mid.rounds[2]!.selection[first!]).toBeUndefined()
    // The *fact* of the commit is visible, same as the draft seal.
    expect(mid.rounds[2]!.selectionCommitted[first!]).toBe(true)
    expect(mid.rounds[2]!.selection[other]).toBeDefined() // your own is never sealed from you

    const second = currentAction(state, other, 'SELECT')!
    state = apply(state, other, {
      type: 'SELECT',
      moduleId: second.moduleId,
      roundIndex: second.roundIndex,
      seat: other,
      slotIndex: second.slots[0]!,
      reason: null,
    })

    expect(project(state, other).rounds[2]!.selection[first!]).toBeDefined()
  })
})

/** Plays rounds 0 and 1 to a 1-1 split, stopping the moment round 2's select is offered. */
function advanceToRound2(state: MatchState): MatchState {
  const results: Record<number, 'A' | 'B'> = { 0: 'A', 1: 'B' }
  let current = state

  for (let guard = 0; guard < 100; guard++) {
    const atRound2Select = current.mode.program[current.cursor]?.id === 'rounds.2.select'
    if (atRound2Select) return current

    const actor = (['A', 'B'] as const).find((s) =>
      project(current, s).legalActions.some((a) => a.type !== 'UNDO_LAST_RESULT'),
    )
    if (!actor) return current

    const report = currentAction(current, actor, 'REPORT_RESULT')
    current = report
      ? apply(current, actor, {
          type: 'REPORT_RESULT',
          moduleId: report.moduleId,
          roundIndex: report.roundIndex,
          reportedBy: actor,
          outcome: results[report.roundIndex] ?? 'A',
        })
      : playFirstLegal(current, actor)
  }
  throw new Error('advanceToRound2: never reached round 2')
}
