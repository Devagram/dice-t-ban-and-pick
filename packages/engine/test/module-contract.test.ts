import { describe, expect, it } from 'vitest'
import {
  baseMode,
  bringBan1Mode,
  legalActions,
  moduleFor,
  reduce,
  resolveMode,
  REGISTRY,
} from '@banpick/engine'
import { canonicalJson, SEATS, type EventPayload, type ResolvedModule } from '@banpick/types'

import {
  apply,
  atModule,
  blindBanMode,
  driveUntil,
  expectOk,
  expectRejected,
  startMatch,
} from './helpers.js'

/**
 * Spec §8 — the module contract.
 *
 * Every module declares the slices it reads and writes, and Phase 2's loader consumes that
 * metadata for the slice-dependency validator. The engine cannot check the metadata is *true*,
 * but it can check it is present and coherent, and that every module honours the rest of the
 * contract: system-driven modules ask nothing of players, and every module rejects an event
 * that belongs to a different module rather than half-applying it.
 */

const PROGRAMS: [string, ResolvedModule[]][] = [
  ['base@4', resolveMode(baseMode, { draftCount: 4 }).program],
  ['base@3', resolveMode(baseMode, { draftCount: 3 }).program],
  ['bring-ban1@4', resolveMode(bringBan1Mode, { draftCount: 4 }).program],
  ['bring-ban1@3', resolveMode(bringBan1Mode, { draftCount: 3 }).program],
  // No shipped mode uses CONDITIONAL_RECOMMIT since the ban moved in front of the draft, but it
  // is still one of §8's nine and still has to honour the module contract. See `blindBanMode`.
  ['blind-ban-fixture@4', resolveMode(blindBanMode, { draftCount: 4 }).program],
]

/** The first module of a given type anywhere in the corpus above. */
function anyModuleOfType(type: ResolvedModule['type']): ResolvedModule {
  for (const [, program] of PROGRAMS) {
    const found = program.find((m) => m.type === type)
    if (found) return found
  }
  throw new Error(`no program in the corpus contains a ${type} module`)
}

describe('§8 metadata', () => {
  it('every registered module declares read and write sets', () => {
    for (const [type, impl] of Object.entries(REGISTRY)) {
      expect(Array.isArray(impl.reads), `${type}.reads`).toBe(true)
      expect(Array.isArray(impl.writes), `${type}.writes`).toBe(true)
    }
  })

  it('ROUND_LOOP is deliberately absent — it is resolved away, not reduced', () => {
    expect('ROUND_LOOP' in REGISTRY).toBe(false)
    // `ResolvedModule` cannot even express a ROUND_LOOP, which is the stronger statement: the
    // flattening is enforced by the type, not by a runtime check nobody would run.
    for (const [, program] of PROGRAMS) {
      expect(program.map((m) => m.type as string)).not.toContain('ROUND_LOOP')
    }
  })

  it('every module in every shipped program has an implementation', () => {
    for (const [label, program] of PROGRAMS) {
      for (const mod of program) {
        expect(() => moduleFor(mod), `${label}/${mod.id}`).not.toThrow()
      }
    }
  })

  it('gives every module a unique id within its program', () => {
    for (const [label, program] of PROGRAMS) {
      const ids = program.map((m) => m.id)
      expect(new Set(ids).size, `${label} has duplicate module ids`).toBe(ids.length)
    }
  })

  it('is deterministic — resolving twice produces the same program', () => {
    for (const draftCount of [3, 4] as const) {
      const a = resolveMode(baseMode, { draftCount })
      const b = resolveMode(baseMode, { draftCount })
      expect(canonicalJson(a)).toBe(canonicalJson(b))
    }
  })
})

describe('system-driven modules ask nothing of players', () => {
  const state = startMatch({ mode: bringBan1Mode, draftCount: 4 })

  // ROLL is deliberately absent: since 2026-07-31 the dice wait for both seats to ask, so it is
  // the one module here that *does* await players. `roll-trigger.test.ts` covers it.
  for (const type of ['ASSIGN', 'REVEAL'] as const) {
    it(`${type} awaits nobody and offers no actions`, () => {
      const mod = anyModuleOfType(type)
      const impl = moduleFor(mod)
      expect(impl.awaiting({ state, mod })).toEqual([])
      for (const seat of SEATS) {
        expect(impl.legalActions({ state, mod }, seat)).toEqual([])
      }
    })
  }

  it('CONDITIONAL_RECOMMIT and CHOOSE produce no system event of their own', () => {
    for (const type of ['CONDITIONAL_RECOMMIT', 'CHOOSE'] as const) {
      const mod = anyModuleOfType(type)
      expect(moduleFor(mod).systemEvent({ state, mod }, 0)).toBeNull()
    }
  })

  it('REPORT_RESULT waits on both seats — either may report (D15)', () => {
    const played = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.0.report'),
    )
    const mod = played.mode.program[played.cursor]!
    expect(moduleFor(mod).awaiting({ state: played, mod }).sort()).toEqual(['A', 'B'])
  })
})

describe('every module rejects an event that is not its own', () => {
  /** One well-formed payload per module type, aimed at the wrong module. */
  const misdirected: Record<string, EventPayload> = {
    SIMULTANEOUS_COMMIT: {
      type: 'COMMIT',
      moduleId: 'somewhere-else',
      seat: 'A',
      picks: [],
      metaBan: null,
    },
    CONDITIONAL_RECOMMIT: {
      type: 'RECOMMIT',
      moduleId: 'somewhere-else',
      seat: 'A',
      replacements: [],
    },
    CHOOSE: {
      type: 'CHOOSE',
      moduleId: 'somewhere-else',
      roundIndex: 0,
      seat: 'A',
      option: 'TURN_ORDER',
    },
    BAN: {
      type: 'BAN',
      moduleId: 'somewhere-else',
      roundIndex: 0,
      seat: 'A',
      tier: 'ROUND',
      target: { seat: 'B', slotIndex: 0 },
    },
    SELECT: {
      type: 'SELECT',
      moduleId: 'somewhere-else',
      roundIndex: 0,
      seat: 'A',
      slotIndex: 0,
      reason: null,
    },
    REPORT_RESULT: {
      type: 'REPORT_RESULT',
      moduleId: 'somewhere-else',
      roundIndex: 0,
      reportedBy: 'A',
      outcome: 'A',
    },
  }

  it('rejects a right-shaped event naming a module that is not current', () => {
    const state = startMatch({ mode: bringBan1Mode, draftCount: 4 })
    const rejection = expectRejected(
      reduce(state, {
        v: 1,
        seq: state.log.length,
        tag: 'misdirected',
        actor: 'A',
        payload: misdirected['SIMULTANEOUS_COMMIT']!,
      }),
    )
    expect(rejection.code).toBe('WRONG_MODULE')
    expect(rejection.detail).toContain('not the current module')
  })

  it('rejects a wrong-shaped event at every phase of a match', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    const seen = new Set<string>()

    for (let guard = 0; guard < 60 && state.status === 'IN_PROGRESS'; guard++) {
      const mod = state.mode.program[state.cursor]
      if (!mod) break
      seen.add(mod.type)

      // Every *other* module's payload shape, addressed to the module that IS current, so this
      // probes each module's own type guard rather than the dispatch check in reduce.
      for (const [type, payload] of Object.entries(misdirected)) {
        if (type === mod.type) continue
        const result = reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'wrong-shape',
          actor: 'A',
          payload: { ...payload, moduleId: mod.id } as EventPayload,
        })
        expect(result.ok, `${mod.type} accepted a ${type} event`).toBe(false)
        if (!result.ok) {
          expect(
            ['WRONG_PHASE', 'NOT_YOUR_TURN'],
            `${mod.type} gave ${result.code} for a ${type} event`,
          ).toContain(result.code)
        }
      }

      const seat = SEATS.find((s) =>
        legalActions(state, s).some((a) => a.type !== 'UNDO_LAST_RESULT'),
      )
      if (!seat) break
      state = advance(state, seat)
    }

    // Confirm the walk actually visited the interesting modules rather than bailing early.
    expect(seen).toContain('SIMULTANEOUS_COMMIT')
    expect(seen).toContain('BAN')
    expect(seen).toContain('SELECT')
    expect(seen).toContain('REPORT_RESULT')
  })
})

describe('between reduce and settle', () => {
  it('offers nothing when the program is exhausted but the match is not yet closed', () => {
    // The state a Durable Object holds for one tick: `reduce` has consumed the final report,
    // the cursor is past the last module, and MATCH_COMPLETE has not been drained yet.
    let state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4 }),
      atModule('rounds.2.report'),
    )
    const report = legalActions(state, 'A').find((a) => a.type === 'REPORT_RESULT')!

    const unsettled = expectOk(
      reduce(state, {
        v: 1,
        seq: state.log.length,
        tag: 'final',
        actor: 'A',
        payload: {
          type: 'REPORT_RESULT',
          moduleId: report.moduleId,
          roundIndex: 2,
          reportedBy: 'A',
          outcome: 'TIE',
        },
      }),
    )

    expect(unsettled.status).toBe('IN_PROGRESS')
    expect(unsettled.cursor).toBe(unsettled.mode.program.length)
    // No module, so nothing on offer but the undo.
    expect(legalActions(unsettled, 'A').map((a) => a.type)).toEqual(['UNDO_LAST_RESULT'])

    state = apply(unsettled, 'A', { type: 'UNDO_LAST_RESULT', roundIndex: 2, requestedBy: 'A' })
    expect(state.status).toBe('IN_PROGRESS')
  })
})

describe('canonical serialization edge cases', () => {
  it('writes an undefined array member as null rather than dropping it', () => {
    // Dropping it would shift every later index, and slot order is meaningful (§5).
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]')
  })

  it('sorts nested keys, not only top-level ones', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}')
  })

  it('handles the primitives that do have a JSON form', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(1.5)).toBe('1.5')
  })

  it('refuses a bare symbol', () => {
    expect(() => canonicalJson(Symbol('nope'))).toThrow(TypeError)
  })
})

function advance(state: ReturnType<typeof startMatch>, seat: 'A' | 'B') {
  const action = legalActions(state, seat).find((a) => a.type !== 'UNDO_LAST_RESULT')!
  switch (action.type) {
    case 'COMMIT':
      return apply(state, seat, {
        type: 'COMMIT',
        moduleId: action.moduleId,
        seat,
        picks: action.picks!.poolBySlot.map((pool, i) => pool[i]!),
        metaBan: null,
      })
    case 'CHOOSE':
      return apply(state, seat, {
        type: 'CHOOSE',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        option: action.options[0]!,
      })
    case 'BAN':
      return apply(state, seat, {
        type: 'BAN',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        tier: 'ROUND',
        target: action.targets[0]!,
      })
    case 'SELECT':
      return apply(state, seat, {
        type: 'SELECT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        slotIndex: action.slots[0]!,
        reason: null,
      })
    case 'REPORT_RESULT':
      return apply(state, seat, {
        type: 'REPORT_RESULT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        reportedBy: seat,
        outcome: action.roundIndex === 0 ? 'A' : 'B',
      })
    case 'ROLL':
      // The dice are gated on both seats asking for them, so a driver has to ask.
      return apply(state, seat, {
        type: 'ROLL_READY',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
      })
    default:
      throw new Error(`advance: unexpected ${action.type}`)
  }
}
