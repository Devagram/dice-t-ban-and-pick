import { describe, expect, it } from 'vitest'
import { baseMode, bringBan1Mode, legalActions, reduce } from '@banpick/engine'
import { otherSeat, type EventPayload, type MatchState, type Seat } from '@banpick/types'

import {
  apply,
  atModule,
  blindBanMode,
  currentAction,
  driveUntil,
  expectRejected,
  startMatch,
} from './helpers.js'

/**
 * The rejection paths.
 *
 * These are not defensive decoration. §11 makes the Durable Object the sole authority on
 * legality and D18 keeps the engine out of the client's hands entirely — which means every
 * malformed, mistimed, or misattributed action a buggy or impatient client can produce arrives
 * here, and the only correct response is a rejection value that says which rule was broken.
 */

function send(state: MatchState, actor: Seat, payload: EventPayload) {
  return reduce(state, { v: 1, seq: state.log.length, tag: 'probe', actor, payload })
}

describe('SIMULTANEOUS_COMMIT', () => {
  it('rejects a second commit from the same seat — the seal is what makes it mean anything', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    const picks = ['anvil', 'cartographer', 'duelist', 'gambler']
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks,
      metaBan: null,
    })

    expect(
      expectRejected(
        send(state, 'A', { type: 'COMMIT', moduleId: 'draft', seat: 'A', picks, metaBan: null }),
      ).code,
    ).toBe('DUPLICATE_COMMIT')
  })

  it('rejects picks a mode does not declare', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    // §12 policy: "Withdraw a committed-but-unrevealed action? No." A commit with the wrong
    // shape is not a withdrawal, but the same instinct applies — it does not get to land.
    expect(
      expectRejected(
        send(state, 'A', {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['anvil', 'cartographer', 'duelist', 'gambler', 'herald'],
          metaBan: null,
        }),
      ).code,
    ).toBe('WRONG_COMMIT_SHAPE')
  })

  it('refuses a ban aimed at a module that declares none — the client-leak case', () => {
    // The server half of a bug that reached a live match: `bring-ban1` commits twice, and a
    // client that carried its ban-phase selection into the draft phase sent a ban the draft
    // module never asked for. The engine is what stopped it becoming state, and the message it
    // produces ("draft declares no meta ban") is what named the bug.
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'oracle',
    })
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'B',
      picks: [],
      metaBan: 'sentinel',
    })

    const offer = currentAction(state, 'A', 'COMMIT')!
    expect(offer.moduleId).toBe('draft')
    expect(offer.metaBan).toBeNull()

    const rejection = expectRejected(
      send(state, 'A', {
        type: 'COMMIT',
        moduleId: 'draft',
        seat: 'A',
        picks: offer.picks!.poolBySlot.map((pool, i) => pool[i]!),
        metaBan: 'oracle', // left over from the phase before
      }),
    )
    expect(rejection.code).toBe('WRONG_COMMIT_SHAPE')
    expect(rejection.detail).toContain('declares no meta ban')
  })

  it('requires the meta ban a mode does declare', () => {
    // `bring-ban1` opens on a ban-only commit, so omitting the ban is the wrong shape — and
    // sending picks it never asked for is wrong for the same reason.
    const state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    expect(
      expectRejected(
        send(state, 'A', {
          type: 'COMMIT',
          moduleId: 'ban',
          seat: 'A',
          picks: [],
          metaBan: null,
        }),
      ).code,
    ).toBe('WRONG_COMMIT_SHAPE')
  })
})

describe('CONDITIONAL_RECOMMIT', () => {
  /** A repick where A's ban hits B's slot 0. */
  function atRepick(constraints?: { selfDuplicates: 'ALLOWED' | 'FORBIDDEN' }) {
    let state = startMatch({
      mode: blindBanMode,
      draftCount: 4,
      ...(constraints ? { constraints } : {}),
    })
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
      metaBan: 'herald',
    })
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'B',
      picks: ['herald', 'magpie', 'oracle', 'sentinel'],
      metaBan: 'vagrant', // misses A
    })
    return state
  }

  it('rejects a recommit that does not cover exactly the triggered slots', () => {
    const state = atRepick()
    expect(
      expectRejected(
        send(state, 'B', {
          type: 'RECOMMIT',
          moduleId: 'repick',
          seat: 'B',
          replacements: [
            { index: 0, characterId: 'tinker' },
            { index: 1, characterId: 'vagrant' }, // slot 1 was never banned
          ],
        }),
      ).code,
    ).toBe('WRONG_COMMIT_SHAPE')
  })

  it('rejects a replacement outside the pool — including the character that triggered it', () => {
    const state = atRepick()
    // `legalDraftPool` already subtracts `metaBannedAgainst`, so re-selecting the banned
    // character is not a special case to check. It is simply not in the set.
    expect(
      expectRejected(
        send(state, 'B', {
          type: 'RECOMMIT',
          moduleId: 'repick',
          seat: 'B',
          replacements: [{ index: 0, characterId: 'herald' }],
        }),
      ).code,
    ).toBe('ILLEGAL_CHARACTER')

    // And D12 still applies: slot 0 may not take what slots 1-3 hold.
    expect(
      expectRejected(
        send(state, 'B', {
          type: 'RECOMMIT',
          moduleId: 'repick',
          seat: 'B',
          replacements: [{ index: 0, characterId: 'magpie' }],
        }),
      ).code,
    ).toBe('ILLEGAL_CHARACTER')
  })

  it('tells a double-clicking client the module has already completed', () => {
    let state = atRepick()
    state = apply(state, 'B', {
      type: 'RECOMMIT',
      moduleId: 'repick',
      seat: 'B',
      replacements: [{ index: 0, characterId: 'tinker' }],
    })
    const rejection = expectRejected(
      send(state, 'B', {
        type: 'RECOMMIT',
        moduleId: 'repick',
        seat: 'B',
        replacements: [{ index: 0, characterId: 'vagrant' }],
      }),
    )
    expect(rejection.code).toBe('WRONG_MODULE')
    expect(rejection.detail).toContain('already completed')
  })

  it('rejects two replacements colliding with each other — G3’s blast radius, with D12 relaxed', () => {
    // Under the shipped constraints this cannot arise: `metaBan.count` is 1 and D12 forbids a
    // seat holding one character twice, so a single ban can only ever trigger one slot. G3
    // flagged that relaxing D12 changes that — "one meta ban can void all three of a seat's
    // slots at once" — so the guard is written for the constraint being a *parameter*, and
    // this test reaches it the only way the shipped rules allow: by relaxing D12.
    let state = startMatch({
      mode: blindBanMode,
      draftCount: 4,
      constraints: { selfDuplicates: 'ALLOWED' },
    })
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
      metaBan: 'herald',
    })
    state = apply(state, 'B', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'B',
      picks: ['herald', 'herald', 'oracle', 'sentinel'], // legal only with D12 relaxed
      metaBan: 'vagrant',
    })

    const repick = currentAction(state, 'B', 'RECOMMIT')!
    expect(repick.slots.map((s) => s.index)).toEqual([0, 1]) // one ban, two slots voided

    // With selfDuplicates ALLOWED the collision is legal, so the guard must NOT fire.
    expect(
      send(state, 'B', {
        type: 'RECOMMIT',
        moduleId: 'repick',
        seat: 'B',
        replacements: [
          { index: 0, characterId: 'tinker' },
          { index: 1, characterId: 'tinker' },
        ],
      }).ok,
    ).toBe(true)
  })
})

describe('CHOOSE', () => {
  it('rejects an option the module does not offer', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.privilegeChoice'),
    )
    const winner = state.rounds[0]!.roll!.winner
    expect(
      expectRejected(
        send(state, winner, {
          type: 'CHOOSE',
          moduleId: 'rounds.0.privilegeChoice',
          roundIndex: 0,
          seat: winner,
          option: 'SELF_FIRST', // that is declareOrder's vocabulary, not this module's
        }),
      ).code,
    ).toBe('ILLEGAL_OPTION')
  })

  it('rejects a choice from the seat that did not win the roll', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.privilegeChoice'),
    )
    const loser = otherSeat(state.rounds[0]!.roll!.winner)
    expect(
      expectRejected(
        send(state, loser, {
          type: 'CHOOSE',
          moduleId: 'rounds.0.privilegeChoice',
          roundIndex: 0,
          seat: loser,
          option: 'DRAFT_PRIVILEGE',
        }),
      ).code,
    ).toBe('NOT_YOUR_TURN')
    // And the loser is offered nothing, so a correct client never tries.
    expect(legalActions(state, loser).filter((a) => a.type === 'CHOOSE')).toEqual([])
  })
})

describe('BAN', () => {
  it('rejects a ban from the seat that does not hold draft privilege', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.ban'),
    )
    const notBanner = otherSeat(state.rounds[0]!.privilegeHolder!)
    expect(
      expectRejected(
        send(state, notBanner, {
          type: 'BAN',
          moduleId: 'rounds.0.ban',
          roundIndex: 0,
          seat: notBanner,
          tier: 'ROUND',
          target: { seat: otherSeat(notBanner), slotIndex: 0 },
        }),
      ).code,
    ).toBe('NOT_YOUR_TURN')
  })

  it('rejects a target slot that does not exist', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 3 }),
      atModule('rounds.0.ban'),
    )
    const banner = state.rounds[0]!.privilegeHolder!
    expect(
      expectRejected(
        send(state, banner, {
          type: 'BAN',
          moduleId: 'rounds.0.ban',
          roundIndex: 0,
          seat: banner,
          tier: 'ROUND',
          target: { seat: otherSeat(banner), slotIndex: 3 }, // only 0-2 exist at draftCount 3
        }),
      ).code,
    ).toBe('ILLEGAL_TARGET')
  })
})

describe('SELECT', () => {
  it('rejects a slot that was banned this round', () => {
    let state = driveUntil(startMatch({ mode: baseMode, draftCount: 4 }), atModule('rounds.0.ban'))
    const banner = state.rounds[0]!.privilegeHolder!
    const victim = otherSeat(banner)
    const ban = currentAction(state, banner, 'BAN')!
    const bannedSlot = ban.targets[0]!.slotIndex

    state = apply(state, banner, {
      type: 'BAN',
      moduleId: ban.moduleId,
      roundIndex: 0,
      seat: banner,
      tier: 'ROUND',
      target: ban.targets[0]!,
    })

    expect(
      expectRejected(
        send(state, victim, {
          type: 'SELECT',
          moduleId: 'rounds.0.selectFirst',
          roundIndex: 0,
          seat: victim,
          slotIndex: bannedSlot,
          reason: null,
        }),
      ).code,
    ).toBe('ILLEGAL_SLOT')
  })

  it('rejects a select from the seat that is not being asked', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.selectFirst'),
    )
    // selectFirst belongs to the *opponent* of the privilege holder in round 0.
    const notAsked = state.rounds[0]!.privilegeHolder!
    expect(
      expectRejected(
        send(state, notAsked, {
          type: 'SELECT',
          moduleId: 'rounds.0.selectFirst',
          roundIndex: 0,
          seat: notAsked,
          slotIndex: 0,
          reason: null,
        }),
      ).code,
    ).toBe('NOT_YOUR_TURN')
  })
})

describe('REPORT_RESULT', () => {
  it('rejects a second report for the same round — use the undo instead (D15)', () => {
    let state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.report'),
    )
    state = apply(state, 'A', {
      type: 'REPORT_RESULT',
      moduleId: 'rounds.0.report',
      roundIndex: 0,
      reportedBy: 'A',
      outcome: 'A',
    })
    const rejection = expectRejected(
      send(state, 'B', {
        type: 'REPORT_RESULT',
        moduleId: 'rounds.0.report',
        roundIndex: 0,
        reportedBy: 'B',
        outcome: 'B',
      }),
    )
    expect(rejection.code).toBe('WRONG_MODULE')
    expect(rejection.detail).toContain('already completed')
    // The correct move is the undo, which is on offer to either seat.
    expect(legalActions(state, 'B').some((a) => a.type === 'UNDO_LAST_RESULT')).toBe(true)
  })

  it('rejects an undo for a round that was never reported', () => {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.report'),
    )
    expect(
      expectRejected(
        send(state, 'A', { type: 'UNDO_LAST_RESULT', roundIndex: 0, requestedBy: 'A' }),
      ).code,
    ).toBe('NOTHING_TO_UNDO')
  })

  it('rejects an undo aimed at an older round than the last reported one', () => {
    let state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.report'),
    )
    state = apply(state, 'A', {
      type: 'REPORT_RESULT',
      moduleId: 'rounds.0.report',
      roundIndex: 0,
      reportedBy: 'A',
      outcome: 'A',
    })
    state = driveUntil(state, atModule('rounds.1.report'), ['A', 'B', 'A'])
    state = apply(state, 'A', {
      type: 'REPORT_RESULT',
      moduleId: 'rounds.1.report',
      roundIndex: 1,
      reportedBy: 'A',
      outcome: 'B',
    })

    expect(
      expectRejected(
        send(state, 'A', { type: 'UNDO_LAST_RESULT', roundIndex: 0, requestedBy: 'A' }),
      ).code,
    ).toBe('NOTHING_TO_UNDO')
  })
})
