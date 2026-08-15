import { describe, expect, it } from 'vitest'
import {
  ENGINE_VERSION,
  legalActions,
  project,
  reduce,
  settle,
  systemStep,
  type ENGINE_VERSION as _V,
} from '@banpick/engine'
import { defaultVariant, variantFor } from '@banpick/loader'
import {
  canonicalJson,
  SEATS,
  type EventEnvelope,
  type MatchState,
  type Roster,
  type RoundOutcome,
  type Ruleset,
  type Seat,
} from '@banpick/types'

import { loadShipped, GAME_ROSTER, ROSTER_75 } from './helpers.js'

/**
 * The whole path, end to end: **YAML file → validated mode → a played match → a replay.**
 *
 * Phase 1 proved the engine plays the modes it was handed. This proves a mode can travel from a
 * config file to a terminal state with no engine change anywhere, which is the claim §1 makes
 * and the one Phase 6 will be graded against ("zero lines changed in `@banpick/engine`").
 */

function rulesetFor(loaded: ReturnType<typeof loadShipped>, draftCount: 3 | 4, roster: Roster) {
  const variant = variantFor(loaded, { draftCount })
  const ruleset: Ruleset = {
    modeId: variant.mode.modeId,
    parameters: variant.parameters,
    rosterVersion: roster.rosterVersion,
    globalBanned: [],
    constraints: {
      crossSeatMirrors: 'ALLOWED',
      selfDuplicates: 'FORBIDDEN',
      repeatBans: 'FORBIDDEN',
    },
    onTie: variant.mode.onTie,
    match: variant.mode.match,
    overtime: variant.mode.overtime,
    modeContentHash: variant.modeContentHash,
  }
  return { variant, ruleset }
}

/** Creates and seats a match from a loaded mode, exactly as the Durable Object will in Phase 3. */
function startFromYaml(name: string, draftCount: 3 | 4, roster: Roster = GAME_ROSTER): MatchState {
  const { variant, ruleset } = rulesetFor(loadShipped(name, { roster }), draftCount, roster)

  let state = ok(
    reduce(null, {
      v: 1,
      seq: 0,
      tag: 'match:created',
      actor: 'SYSTEM',
      payload: {
        type: 'MATCH_CREATED',
        seed: `e2e-${name}-${draftCount}`,
        ruleset,
        roster,
        mode: variant.mode,
        engineVersion: ENGINE_VERSION,
      },
    }),
  )
  for (const seat of SEATS) {
    state = settle(
      ok(
        reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'seat',
          actor: seat,
          payload: { type: 'SEAT_FILLED', seat },
        }),
      ),
    )
  }
  return state
}

function ok(result: ReturnType<typeof reduce>): MatchState {
  if (!result.ok) throw new Error(`reduce rejected: ${result.code} — ${result.detail}`)
  return result.state
}

/** Plays to a terminal state, taking the first legal option and `results[n]` for round n. */
function play(state: MatchState, results: RoundOutcome[]): MatchState {
  let current = state
  for (let guard = 0; guard < 200 && current.status === 'IN_PROGRESS'; guard++) {
    const seat = SEATS.find((s) =>
      legalActions(current, s).some(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      ),
    )
    if (!seat) {
      const sys = systemStep(current)
      if (!sys) break
      current = settle(ok(reduce(current, sys)))
      continue
    }
    current = settle(ok(reduce(current, act(current, seat, results))))
  }
  return current
}

function act(state: MatchState, seat: Seat, results: RoundOutcome[]): EventEnvelope {
  const action = legalActions(state, seat).find(
    (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
  )!
  const seq = state.log.length
  const wrap = (payload: EventEnvelope['payload']): EventEnvelope => ({
    v: 1,
    seq,
    tag: 'e2e',
    actor: seat,
    payload,
  })

  switch (action.type) {
    case 'COMMIT':
      return wrap({
        type: 'COMMIT',
        moduleId: action.moduleId,
        seat,
        // A commit may declare picks, a meta ban, or both — `bring-ban1` now opens with a
        // ban-only phase, so neither side can be assumed present.
        picks: action.picks ? action.picks.poolBySlot.map((pool, i) => pool[i]!) : [],
        metaBan: action.metaBan ? action.metaBan.pool[0]! : null,
      })
    case 'ROLL':
      // The dice are gated on both seats asking for them.
      return wrap({
        type: 'ROLL_READY',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
      })
    case 'RECOMMIT':
      return wrap({
        type: 'RECOMMIT',
        moduleId: action.moduleId,
        seat,
        replacements: action.slots.map((s, i) => ({ index: s.index, characterId: s.pool[i]! })),
      })
    case 'CHOOSE':
      return wrap({
        type: 'CHOOSE',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        option: action.options[0]!,
      })
    case 'BAN':
      return wrap({
        type: 'BAN',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        tier: 'ROUND',
        target: action.targets[0]!,
      })
    case 'SELECT':
      return wrap({
        type: 'SELECT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        slotIndex: action.slots[0]!,
        reason: null,
      })
    case 'REPORT_RESULT':
      return wrap({
        type: 'REPORT_RESULT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        reportedBy: seat,
        outcome: results[action.roundIndex] ?? 'A',
      })
    default:
      throw new Error(`unexpected action ${action.type}`)
  }
}

describe('a mode file plays a match', () => {
  for (const name of ['base', 'bring-ban1'] as const) {
    for (const draftCount of [3, 4] as const) {
      it(`${name} @ ${draftCount} reaches a terminal state, loaded from YAML`, () => {
        const final = play(startFromYaml(name, draftCount), ['A', 'B', 'A'])

        expect(final.status).toBe('COMPLETE')
        expect(final.outcome).toBe('A')
        // Four round states, three played: D30 gives every match an overtime round and leaves
        // it unreported unless regulation ends level. `null` here is the round not happening.
        expect(final.rounds.map((r) => r.result)).toEqual(['A', 'B', 'A', null])
        // The hash the loader computed is what the match carries forever (D20).
        expect(final.ruleset.modeContentHash).toMatch(/^[0-9a-f]{12}$/)
      })

      it(`${name} @ ${draftCount} replays from its own log`, () => {
        // Phase 5's exit criterion, reachable already: the log is self-describing because
        // MATCH_CREATED carries the resolved program, so a replay needs no mode registry.
        const final = play(startFromYaml(name, draftCount), ['TIE', 'A', 'B'])
        let replayed: MatchState | null = null
        for (const event of final.log) replayed = ok(reduce(replayed, event))
        expect(canonicalJson(replayed)).toBe(canonicalJson(final))
      })
    }
  }

  it('plays at the ~75-character target scale', () => {
    const final = play(startFromYaml('bring-ban1', 4, ROSTER_75), ['A', 'B', 'TIE'])
    expect(final.status).toBe('COMPLETE')
    expect(final.roster.characters).toHaveLength(75)
  })

  it('reaches a drawn match, which is a legal terminal state (D21)', () => {
    // At 3, where regulation spends every character. D30 decides the same score at 4.
    const final = play(startFromYaml('base', 3), ['TIE', 'TIE', 'TIE'])
    expect(final.outcome).toBe('DRAW')
    expect(final.seats.A.score).toBe(1.5)
  })

  it('breaks the same tie at draftCount 4, where a character is still in hand (D30)', () => {
    const final = play(startFromYaml('base', 4), ['TIE', 'TIE', 'TIE', 'B'])
    expect(final.outcome).toBe('B')
    expect(final.rounds.map((r) => r.result)).toEqual(['TIE', 'TIE', 'TIE', 'B'])
    expect(final.seats.B.score).toBe(2.5)
  })
})

describe('the lobby sees what it is consenting to (§12.3)', () => {
  it('renders the mode, its parameters, and the tie rule before a seat is taken', () => {
    const roster = GAME_ROSTER
    const { variant, ruleset } = rulesetFor(loadShipped('base'), 3, roster)

    const state = ok(
      reduce(null, {
        v: 1,
        seq: 0,
        tag: 'match:created',
        actor: 'SYSTEM',
        payload: {
          type: 'MATCH_CREATED',
          seed: 'lobby',
          ruleset,
          roster,
          mode: variant.mode,
          engineVersion: ENGINE_VERSION,
        },
      }),
    )

    const joiner = project(state, 'B')
    expect(joiner.status).toBe('LOBBY')
    // "A host quietly switching from 4 picks to 3 is exactly the kind of change the joiner must
    // see" — so the parameter value has to survive projection, not just the mode name.
    expect(joiner.mode.label).toBe('Standard Bo3 — draft 3')
    expect(joiner.ruleset.parameters).toEqual({ draftCount: 3 })
    expect(joiner.ruleset.onTie.scoring).toBe('HALF_POINT')
    expect(joiner.ruleset.modeContentHash).toBe(variant.modeContentHash)
  })

  it('offers the default variant when the host touches nothing', () => {
    expect(defaultVariant(loadShipped('base')).parameters).toEqual({ draftCount: 4 })
  })
})
