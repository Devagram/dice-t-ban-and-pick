import { describe, expect, it } from 'vitest'
import { baseMode, legalActions, project, reduce } from '@banpick/engine'
import { canonicalJson, type MatchState } from '@banpick/types'

import { apply, currentAction, expectRejected, startMatch } from './helpers.js'

/**
 * Phase 1 gate — **purity.**
 *
 * "`reduce` does not mutate its input (deep-freeze the input in tests); a lint rule bans `fs`,
 * `crypto.randomUUID`, `Date`, and `Math.random` imports in the package."
 *
 * The lint half runs in CI (see eslint.config.js). This half is the part a lint rule cannot
 * see: that the reducer actually clones rather than editing in place, and that it is **total** —
 * an illegal event returns a rejection value instead of throwing. Throwing reducers and event
 * sourcing are a bad marriage: a throw mid-fold leaves no record of what was attempted.
 */

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  return value
}

describe('purity', () => {
  it('does not mutate a deep-frozen input state', () => {
    const state = deepFreeze(startMatch({ mode: baseMode, draftCount: 4 }))
    const before = canonicalJson(state)

    const commit = currentAction(state, 'A', 'COMMIT')!
    const result = reduce(state, {
      v: 1,
      seq: state.log.length,
      tag: 'draft:COMMIT',
      actor: 'A',
      payload: {
        type: 'COMMIT',
        moduleId: 'draft',
        seat: 'A',
        picks: commit.picks!.poolBySlot.map((pool, i) => pool[i]!),
        metaBan: null,
      },
    })

    expect(result.ok).toBe(true)
    expect(canonicalJson(state)).toBe(before)
    // And the returned state is genuinely different, so nothing passed by aliasing it.
    expect(canonicalJson((result as { state: MatchState }).state)).not.toBe(before)
  })

  it('leaves the input untouched when it rejects', () => {
    const state = deepFreeze(startMatch({ mode: baseMode, draftCount: 4 }))
    const before = canonicalJson(state)

    expectRejected(
      reduce(state, {
        v: 1,
        seq: state.log.length,
        tag: 'draft:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['not-a-character', 'anvil', 'duelist', 'gambler'],
          metaBan: null,
        },
      }),
    )

    expect(canonicalJson(state)).toBe(before)
  })

  it('does not mutate through legalActions or project either', () => {
    const state = deepFreeze(startMatch({ mode: baseMode, draftCount: 4 }))
    const before = canonicalJson(state)

    legalActions(state, 'A')
    project(state, 'A')
    project(state, 'B')

    expect(canonicalJson(state)).toBe(before)
  })
})

describe('totality — reduce rejects, it does not throw', () => {
  const cases: {
    name: string
    code: string
    build: (s: MatchState) => Parameters<typeof reduce>[1]
  }[] = [
    {
      name: 'a character outside the pool',
      code: 'ILLEGAL_CHARACTER',
      build: (s) => ({
        v: 1,
        seq: s.log.length,
        tag: 'draft:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['ghost', 'anvil', 'duelist', 'gambler'],
          metaBan: null,
        },
      }),
    },
    {
      name: 'the wrong number of picks',
      code: 'WRONG_COMMIT_SHAPE',
      build: (s) => ({
        v: 1,
        seq: s.log.length,
        tag: 'draft:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['anvil'],
          metaBan: null,
        },
      }),
    },
    {
      name: 'a self-duplicate (D12)',
      code: 'ILLEGAL_CHARACTER',
      build: (s) => ({
        v: 1,
        seq: s.log.length,
        tag: 'draft:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['anvil', 'anvil', 'duelist', 'gambler'],
          metaBan: null,
        },
      }),
    },
    {
      name: 'an event for a module that is not current',
      code: 'WRONG_MODULE',
      build: (s) => ({
        v: 1,
        seq: s.log.length,
        tag: 'nope:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'not-the-current-module',
          seat: 'A',
          picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
          metaBan: null,
        },
      }),
    },
    {
      name: 'a meta ban in a mode that declares none',
      code: 'WRONG_COMMIT_SHAPE',
      build: (s) => ({
        v: 1,
        seq: s.log.length,
        tag: 'draft:COMMIT',
        actor: 'A',
        payload: {
          type: 'COMMIT',
          moduleId: 'draft',
          seat: 'A',
          picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
          metaBan: 'oracle',
        },
      }),
    },
  ]

  for (const c of cases) {
    it(`rejects ${c.name} with ${c.code}`, () => {
      const state = startMatch({ mode: baseMode, draftCount: 4 })
      let result: ReturnType<typeof reduce>
      expect(() => {
        result = reduce(state, c.build(state))
      }).not.toThrow()
      expect(expectRejected(result!).code).toBe(c.code)
    })
  }

  it('refuses a second MATCH_CREATED', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    const created = state.log[0]!
    expect(expectRejected(reduce(state, created)).code).toBe('ALREADY_CREATED')
  })

  it('refuses any event before the match exists', () => {
    expect(
      expectRejected(
        reduce(null, {
          v: 1,
          seq: 0,
          tag: 'seat',
          actor: 'A',
          payload: { type: 'SEAT_FILLED', seat: 'A' },
        }),
      ).code,
    ).toBe('MATCH_NOT_CREATED')
  })

  it('refuses a duplicate seat claim', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    expect(
      expectRejected(
        reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'seat',
          actor: 'A',
          payload: { type: 'SEAT_FILLED', seat: 'A' },
        }),
      ).code,
    ).toBe('WRONG_PHASE') // the lobby closed when the second seat filled
  })

  it('refuses a seat-authored FORCED select (D26 authorship is the system’s claim)', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    for (const seat of ['A', 'B'] as const) {
      const commit = currentAction(state, seat, 'COMMIT')!
      state = apply(state, seat, {
        type: 'COMMIT',
        moduleId: 'draft',
        seat,
        picks: commit.picks!.poolBySlot.map((pool, i) => pool[i]!),
        metaBan: null,
      })
    }
    // Drive to a select.
    while (
      !(['A', 'B'] as const).some((s) => currentAction(state, s, 'SELECT') !== null) &&
      state.status === 'IN_PROGRESS'
    ) {
      const actor = (['A', 'B'] as const).find((s) =>
        legalActions(state, s).some(
          (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
        ),
      )!
      const action = legalActions(state, actor).find(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      )!
      if (action.type === 'ROLL') {
        // The dice wait for both seats to ask for them.
        state = apply(state, actor, {
          type: 'ROLL_READY',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
        })
      } else if (action.type === 'CHOOSE') {
        state = apply(state, actor, {
          type: 'CHOOSE',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
          option: action.options[0]!,
        })
      } else if (action.type === 'BAN') {
        state = apply(state, actor, {
          type: 'BAN',
          moduleId: action.moduleId,
          roundIndex: action.roundIndex,
          seat: actor,
          tier: 'ROUND',
          target: action.targets[0]!,
        })
      } else break
    }

    const seat = (['A', 'B'] as const).find((s) => currentAction(state, s, 'SELECT') !== null)!
    const select = currentAction(state, seat, 'SELECT')!
    expect(
      expectRejected(
        reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'forged',
          actor: seat,
          payload: {
            type: 'SELECT',
            moduleId: select.moduleId,
            roundIndex: select.roundIndex,
            seat,
            slotIndex: select.slots[0]!,
            reason: 'FORCED',
          },
        }),
      ).code,
    ).toBe('ILLEGAL_OPTION')
  })
})

describe('engine versioning (D16)', () => {
  it('refuses a log written by a different major version, loudly', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    const created = structuredCloneish(state.log[0]!)
    ;(created.payload as { engineVersion: string }).engineVersion = '9.0.0'

    const rejection = expectRejected(reduce(null, created))
    expect(rejection.code).toBe('ENGINE_VERSION_MISMATCH')
    // "Loud, not silent" — the alternative is producing a different terminal state with total
    // confidence and no indication that it did.
    expect(rejection.detail).toContain('9.0.0')
  })

  it('accepts a different minor version', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    const created = structuredCloneish(state.log[0]!)
    ;(created.payload as { engineVersion: string }).engineVersion = '0.99.3'
    expect(reduce(null, created).ok).toBe(true)
  })
})

function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
