import { describe, expect, it } from 'vitest'
import {
  baseMode,
  bringBan1Mode,
  createMatch,
  ENGINE_VERSION,
  legalActions,
  majorOf,
  ModeResolutionError,
  moduleFor,
  project,
  reduce,
  resolveMode,
  settle,
  systemStep,
} from '@banpick/engine'
import type { EventEnvelope, MatchState, Ruleset } from '@banpick/types'

import { apply, expectOk, expectRejected, playMatch, startMatch, ROSTER_10 } from './helpers.js'

/**
 * The lobby (§12) and the projection at states that are not mid-play.
 *
 * §12.3 is the load-bearing requirement here: *"Joiner sees the fully rendered ruleset (mode
 * name, parameter values, global bans, tie rule) before taking a seat. Seating is the
 * consent."* Consent to a summary is not consent, so everything the joiner is agreeing to has
 * to survive projection **before** they have a seat.
 */

function created(overrides: Partial<Ruleset> = {}): EventEnvelope {
  const mode = resolveMode(baseMode, { draftCount: 4 })
  const ruleset: Ruleset = {
    modeId: mode.modeId,
    parameters: mode.parameters,
    rosterVersion: ROSTER_10.rosterVersion,
    globalBanned: ['vagrant'],
    constraints: {
      crossSeatMirrors: 'ALLOWED',
      selfDuplicates: 'FORBIDDEN',
      repeatBans: 'FORBIDDEN',
    },
    onTie: mode.onTie,
    match: mode.match,
    overtime: mode.overtime,
    modeContentHash: 'test-hash',
    ...overrides,
  }
  return {
    v: 1,
    seq: 0,
    tag: 'match:created',
    actor: 'SYSTEM',
    payload: {
      type: 'MATCH_CREATED',
      seed: 'lobby-seed',
      ruleset,
      roster: ROSTER_10,
      mode,
      engineVersion: ENGINE_VERSION,
    },
  }
}

describe('lobby (§12)', () => {
  it('starts in LOBBY with both seats open', () => {
    const state = expectOk(reduce(null, created()))
    expect(state.status).toBe('LOBBY')
    expect(state.seatsFilled).toEqual({ A: false, B: false })
    expect(legalActions(state, 'A')).toEqual([{ type: 'FILL_SEAT', moduleId: null }])
    expect(legalActions(state, 'B')).toEqual([{ type: 'FILL_SEAT', moduleId: null }])
  })

  it('renders the whole ruleset to a joiner before they take a seat', () => {
    // A host quietly switching from 4 picks to 3 is exactly the change the joiner must see.
    const view = project(expectOk(reduce(null, created())), 'B')

    expect(view.status).toBe('LOBBY')
    expect(view.mode.label).toBe('Standard Bo3 — draft 4')
    expect(view.ruleset.parameters).toEqual({ draftCount: 4 })
    expect(view.ruleset.globalBanned).toEqual(['vagrant'])
    expect(view.ruleset.onTie.scoring).toBe('HALF_POINT')
    expect(view.ruleset.match.resolution).toBe('ALWAYS_3_ROUNDS')
    expect(view.roster).toHaveLength(10)
    // Nothing is in play yet, so there is no phase to report.
    expect(view.phase).toBeNull()
  })

  it('offers nothing further to a seat that has already claimed one', () => {
    let state = expectOk(reduce(null, created()))
    state = expectOk(
      reduce(state, {
        v: 1,
        seq: 1,
        tag: 'seat',
        actor: 'A',
        payload: { type: 'SEAT_FILLED', seat: 'A' },
      }),
    )
    expect(state.status).toBe('LOBBY') // still waiting on B
    expect(legalActions(state, 'A')).toEqual([])
    expect(legalActions(state, 'B')).toEqual([{ type: 'FILL_SEAT', moduleId: null }])
  })

  it('refuses a seat someone already holds', () => {
    let state = expectOk(reduce(null, created()))
    state = expectOk(
      reduce(state, {
        v: 1,
        seq: 1,
        tag: 'seat',
        actor: 'A',
        payload: { type: 'SEAT_FILLED', seat: 'A' },
      }),
    )
    expect(
      expectRejected(
        reduce(state, {
          v: 1,
          seq: 2,
          tag: 'seat',
          actor: 'B',
          payload: { type: 'SEAT_FILLED', seat: 'A' },
        }),
      ).code,
    ).toBe('SEAT_TAKEN')
  })

  it('refuses play before both seats are filled — seating is the consent (§12.4)', () => {
    let state = expectOk(reduce(null, created()))
    state = expectOk(
      reduce(state, {
        v: 1,
        seq: 1,
        tag: 'seat',
        actor: 'A',
        payload: { type: 'SEAT_FILLED', seat: 'A' },
      }),
    )
    expect(
      expectRejected(
        reduce(state, {
          v: 1,
          seq: 2,
          tag: 'draft:COMMIT',
          actor: 'A',
          payload: {
            type: 'COMMIT',
            moduleId: 'draft',
            seat: 'A',
            picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
            metaBan: null,
          },
        }),
      ).code,
    ).toBe('WRONG_PHASE')
  })

  it('opens play the moment the second seat fills', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    expect(state.status).toBe('IN_PROGRESS')
    expect(project(state, 'A').phase).toMatchObject({
      moduleId: 'draft',
      type: 'SIMULTANEOUS_COMMIT',
    })
  })

  it('snapshots the ruleset, roster, and program rather than referencing them (§11.2)', () => {
    const state = expectOk(reduce(null, created()))
    // Everything needed to replay is in the state, taken from the creation event. Nothing is
    // resolved from a registry at read time, so editing a mode file cannot reach a live match.
    expect(state.roster.characters).toHaveLength(10)
    expect(state.mode.program.length).toBeGreaterThan(10)
    expect(state.seed).toBe('lobby-seed')
    expect(state.engineVersion).toBe(ENGINE_VERSION)
  })
})

describe('projection at a terminal state', () => {
  it('reports the outcome and stops reporting a phase', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'TIE'])
    const view = project(final, 'A')

    expect(view.status).toBe('COMPLETE')
    expect(view.outcome).toBe(final.outcome)
    expect(view.phase).toBeNull()
    // Both seats are fully open at the end — nothing is left sealed after the match.
    expect(view.opponent.slots).toBeDefined()
    expect(view.rounds.every((r) => r.result !== null)).toBe(true)
  })

  it('offers the undo and the amendment, and no way to keep playing', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    const actions = legalActions(final, 'A')

    // Both corrections outlive the match, for different mistakes: D15's undo is the result you
    // just entered, D33's amendment is the one you notice later. Neither is a move.
    expect(actions.map((a) => a.type).sort()).toEqual(['AMEND_RESULT', 'UNDO_LAST_RESULT'])

    const amend = actions.find((a) => a.type === 'AMEND_RESULT')!
    // Every round that was played, not just the last one.
    expect(amend.rounds.map((r) => r.roundIndex)).toEqual([0, 1, 2])
    expect(amend.rounds[0]).toMatchObject({ current: 'A', outcomes: ['A', 'B', 'TIE'] })
  })

  it('refuses further play once complete', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'A', 'A'])
    expect(
      expectRejected(
        reduce(final, {
          v: 1,
          seq: final.log.length,
          tag: 'late',
          actor: 'A',
          payload: {
            type: 'CHOOSE',
            moduleId: 'rounds.2.declareOrder',
            roundIndex: 2,
            seat: 'A',
            option: 'SELF_FIRST',
          },
        }),
      ).code,
    ).toBe('MATCH_COMPLETE')
  })

  it('has nothing further for the system to do', () => {
    const final = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    expect(systemStep(final)).toBeNull()
    expect(settle(final)).toBe(final)
  })
})

describe('projection reports who is being waited on', () => {
  it('names both seats during a simultaneous commit, then just the laggard', () => {
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    expect(project(state, 'A').phase!.awaiting.sort()).toEqual(['A', 'B'])

    // The ban phase is the first simultaneous commit now.
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'oracle',
    })
    expect(project(state, 'A').phase!.awaiting).toEqual(['B'])
    expect(project(state, 'B').phase!.awaiting).toEqual(['B'])
  })
})

describe('engine internals that guard against a bad program', () => {
  it('refuses a module type with no implementation', () => {
    expect(() => moduleFor({ type: 'NONSENSE' } as never)).toThrow(TypeError)
  })

  it('refuses a nested round loop', () => {
    const nested = {
      ...baseMode,
      modules: [
        {
          type: 'ROUND_LOOP' as const,
          id: 'outer',
          count: 1,
          template: [{ type: 'ROUND_LOOP', id: 'inner' }] as never,
          overrides: {},
        },
      ],
    }
    expect(() => resolveMode(nested, { draftCount: 4 })).toThrow(ModeResolutionError)
  })

  it('parses a major version out of a semver string', () => {
    expect(majorOf('1.2.3')).toBe('1')
    expect(majorOf('0.1.0')).toBe('0')
    expect(majorOf('nonsense')).toBe('nonsense')
  })

  it('builds initial state with every round pre-created and empty', () => {
    const state: MatchState = createMatch(created())
    // Three regulation rounds plus D30's overtime round, which exists from the start and is
    // simply never reported unless it is owed.
    expect(state.rounds).toHaveLength(4)
    for (const round of state.rounds) {
      expect(round.result).toBeNull()
      expect(round.privilegeHolder).toBeNull()
      expect(round.selection.A.value).toBeNull()
    }
  })
})
