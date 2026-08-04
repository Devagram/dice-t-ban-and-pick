import { describe, expect, it } from 'vitest'
import { baseMode, bringBan1Mode, reduce } from '@banpick/engine'
import { canonicalJson, type EventEnvelope, type MatchState } from '@banpick/types'

import {
  apply,
  currentAction,
  expectOk,
  expectRejected,
  playMatch,
  startMatch,
  ROSTER_10,
} from './helpers.js'

/**
 * Phase 1 gate — **golden replay.**
 *
 * "A scripted event list plays the mode to a terminal state; the final `MatchState` matches a
 * checked-in fixture byte for byte."
 *
 * Rather than checking in a state blob nobody can read, the fixture is the **event log** and
 * the assertion is that replaying it reproduces the same state. That is the stronger claim: it
 * is the same property Phase 5's export/replay gate needs, tested three phases early.
 */

function replay(log: EventEnvelope[]): MatchState {
  let state: MatchState | null = null
  for (const event of log) {
    state = expectOk(reduce(state, event))
  }
  if (!state) throw new Error('replay: empty log')
  return state
}

describe('golden replay — base', () => {
  for (const draftCount of [3, 4] as const) {
    it(`plays to a terminal state at draftCount ${draftCount}`, () => {
      const final = playMatch(startMatch({ mode: baseMode, draftCount }), ['A', 'B', 'A'])

      expect(final.status).toBe('COMPLETE')
      expect(final.outcome).toBe('A')
      expect(final.seats.A.score).toBe(2)
      expect(final.seats.B.score).toBe(1)
      // The fourth is D30's overtime round: present in every match, played only when
      // regulation ends level. 2-1 is not level.
      expect(final.rounds.map((r) => r.result)).toEqual(['A', 'B', 'A', null])

      // Every round consumed exactly one slot per seat.
      for (const seat of ['A', 'B'] as const) {
        const consumed = final.seats[seat].slots.value.filter((s) => s.consumed)
        expect(consumed).toHaveLength(3)
      }
    })

    it(`replays byte for byte at draftCount ${draftCount}`, () => {
      const final = playMatch(startMatch({ mode: baseMode, draftCount }), ['A', 'B', 'A'])
      const replayed = replay(final.log)
      expect(canonicalJson(replayed)).toBe(canonicalJson(final))
    })
  }

  it('records the D10 privilege sequence: R0 chosen, R1 inverted, R2 rolled', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    const [r0, r1, r2] = final.rounds

    // R1 fully inverts both privileges (D10) — not just the draft privilege, or the round-0
    // winner would hold turn order across two consecutive rounds.
    expect(r1!.privilegeHolder).toBe(r0!.privilegeHolder === 'A' ? 'B' : 'A')
    expect(r1!.turnOrderHolder).toBe(r0!.turnOrderHolder === 'A' ? 'B' : 'A')
    expect(final.log.some((e) => e.payload.type === 'ASSIGN')).toBe(true)

    // R2 has no draft privilege at all (D11), and its roll assigns turn order directly.
    expect(r2!.privilegeHolder).toBeNull()
    expect(r2!.turnOrderHolder).not.toBeNull()
    expect(r2!.roll).not.toBeNull()
    expect(r2!.turnOrderHolder).toBe(r2!.roll!.winner)

    // No CHOOSE survives in round 2 except D24's declareOrder.
    const r2Chooses = final.log.filter(
      (e) => e.payload.type === 'CHOOSE' && e.payload.roundIndex === 2,
    )
    expect(r2Chooses).toHaveLength(1)
    expect(r2Chooses[0]!.payload).toMatchObject({ moduleId: 'rounds.2.declareOrder' })
  })

  it('declares play order after both selections, in every round (D24)', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])

    // Regulation only — the overtime round was never played, so it declared nothing.
    for (const round of final.rounds.slice(0, 3)) {
      expect(round.playOrder).not.toBeNull()
      expect(round.playOrder!.declaredBy).toBe(round.turnOrderHolder)
    }
    expect(final.rounds[3]!.playOrder).toBeNull()

    // The order decision must come after both selects of its round — deciding it blind would
    // be a coin flip with ceremony.
    for (const roundIndex of [0, 1, 2]) {
      const declareAt = final.log.findIndex(
        (e) =>
          e.payload.type === 'CHOOSE' && e.payload.moduleId === `rounds.${roundIndex}.declareOrder`,
      )
      const selects = final.log.filter(
        (e) => e.payload.type === 'SELECT' && e.payload.roundIndex === roundIndex,
      )
      expect(selects).toHaveLength(2)
      for (const s of selects) expect(final.log.indexOf(s)).toBeLessThan(declareAt)
    }
  })
})

describe('golden replay — bring-ban1 (hidden mode)', () => {
  for (const draftCount of [3, 4] as const) {
    it(`plays both reveal gates to a terminal state at draftCount ${draftCount}`, () => {
      const final = playMatch(startMatch({ mode: bringBan1Mode, draftCount }), ['A', 'B', 'A'])

      expect(final.status).toBe('COMPLETE')
      expect(final.log.some((e) => e.tag === 'ban:reveal')).toBe(true) // gate one
      expect(final.log.some((e) => e.tag === 'pickReveal:reveal')).toBe(true) // gate two

      // Gate one strictly precedes gate two, and the *draft* sits between them — which is the
      // whole point of the reordering: you choose knowing what was banned.
      const gate1 = final.log.findIndex((e) => e.tag === 'ban:reveal')
      const gate2 = final.log.findIndex((e) => e.tag === 'pickReveal:reveal')
      const draft = final.log.findIndex((e) => e.tag === 'draft:COMMIT')
      expect(gate1).toBeLessThan(draft)
      expect(draft).toBeLessThan(gate2)
    })

    it(`replays byte for byte at draftCount ${draftCount}`, () => {
      const final = playMatch(startMatch({ mode: bringBan1Mode, draftCount }), ['A', 'B', 'A'])
      expect(canonicalJson(replay(final.log))).toBe(canonicalJson(final))
    })
  }

  it('makes the ban bite the draft instead of needing a repick', () => {
    // **This test inverted when the ban moved in front of the draft.** It used to assert that a
    // RECOMMIT happened — a blind ban hit a drafted character and the seat had to swap it out.
    // Now the ban lands before anyone drafts, so the character is simply never draftable and
    // there is nothing to repair. Same guarantee, reached without the repair step.
    const final = playMatch(startMatch({ mode: bringBan1Mode, draftCount: 4 }), ['A', 'B', 'A'])

    expect(final.log.filter((e) => e.payload.type === 'RECOMMIT')).toHaveLength(0)
    expect(final.metaBannedAgainst.A.length + final.metaBannedAgainst.B.length).toBeGreaterThan(0)

    // Nobody ends up holding a character banned against them. That is the whole job, and it is
    // now enforced by the pool rather than by a correction after the fact.
    for (const seat of ['A', 'B'] as const) {
      const held = final.seats[seat].slots.value.map((s) => s.characterId)
      for (const banned of final.metaBannedAgainst[seat]) {
        expect(held).not.toContain(banned)
      }
    }
  })

  it('places the meta ban against the opponent, never the banner (D4)', () => {
    // The seats must ban *different* characters for the direction to be observable at all —
    // with the same ban on both sides, "denied to A" and "denied by A" coincide.
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    const banA = 'oracle'
    const banB = 'sentinel'

    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: banA,
    })
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'B',
      picks: [],
      metaBan: banB,
    })

    // D4 — a meta ban is scoped to one *opponent* seat, so no self-own is possible.
    expect(state.metaBannedAgainst.B).toEqual([banA])
    expect(state.metaBannedAgainst.A).toEqual([banB])
    expect(state.metaBannedAgainst.A).not.toContain(banA)

    // The direction is now visible in the *pools*, which is stronger than seeing it in a repick:
    // A banned `oracle`, so it is gone from B's draft and still available to A.
    const bPool = currentAction(state, 'B', 'COMMIT')!.picks!.poolBySlot[0]!
    const aPool = currentAction(state, 'A', 'COMMIT')!.picks!.poolBySlot[0]!
    expect(bPool).not.toContain(banA)
    expect(aPool).toContain(banA)
    // And symmetrically for B's ban.
    expect(aPool).not.toContain(banB)
    expect(bPool).toContain(banB)

    // §9.2's real point survives the reordering: the ban *steals* a mirror rather than
    // preventing one — A may still draft the character A banned, and now knowingly.
  })

  it('forbids a meta ban on an already globally banned character', () => {
    // §6 calls this "the payoff for keeping bans as set algebra rather than procedures": the
    // rule is written nowhere. It falls out of `activeRoster \ globalBanned`.
    const banned = ROSTER_10.characters[0]!.id
    const state = startMatch({ mode: bringBan1Mode, draftCount: 4, globalBanned: [banned] })

    // The opening commit is the ban phase, so it offers a meta ban and no picks.
    const commit = currentAction(state, 'A', 'COMMIT')
    expect(commit).not.toBeNull()
    expect(commit!.picks).toBeNull()
    expect(commit!.metaBan!.pool).not.toContain(banned)

    const rejection = expectRejected(
      reduce(state, {
        v: 1,
        seq: state.log.length,
        tag: 'ban:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'ban',
          seat: 'A',
          picks: [],
          metaBan: banned,
        },
      }),
    )
    expect(rejection.code).toBe('ILLEGAL_CHARACTER')
  })
})
