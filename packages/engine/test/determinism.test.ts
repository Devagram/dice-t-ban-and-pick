import { describe, expect, it } from 'vitest'
import { baseMode, bringBan1Mode, reduce, rollDice, rollDie } from '@banpick/engine'
import { canonicalJson, type EventEnvelope, type MatchState } from '@banpick/types'

import { expectOk, playMatch, startMatch } from './helpers.js'

/**
 * Phase 1 gate — **determinism.** "The same event list replayed 100× produces an identical
 * state hash."
 *
 * This is the property §11 non-negotiable 1 is really asking for. If it holds, every roll in
 * every past match is reproducible, which is what makes the log a record two people can argue
 * from rather than a story the server tells.
 */

function replay(log: EventEnvelope[]): MatchState {
  let state: MatchState | null = null
  for (const event of log) state = expectOk(reduce(state, event))
  return state!
}

describe('determinism', () => {
  for (const mode of [baseMode, bringBan1Mode]) {
    it(`${mode.modeId} replays identically 100 times`, () => {
      const final = playMatch(startMatch({ mode, draftCount: 4 }), ['A', 'B', 'A'])
      const expected = canonicalJson(final)

      for (let i = 0; i < 100; i++) {
        expect(canonicalJson(replay(final.log))).toBe(expected)
      }
    })
  }

  it('produces the same match from the same seed, and a different one from a different seed', () => {
    const a = playMatch(startMatch({ mode: baseMode, draftCount: 4, seed: 'seed-one' }))
    const b = playMatch(startMatch({ mode: baseMode, draftCount: 4, seed: 'seed-one' }))
    const c = playMatch(startMatch({ mode: baseMode, draftCount: 4, seed: 'seed-two' }))

    expect(canonicalJson(a)).toBe(canonicalJson(b))

    const rolls = (s: MatchState) => s.rounds.map((r) => r.roll?.results)
    expect(rolls(a)).not.toEqual(rolls(c))
  })
})

describe('counter-based RNG', () => {
  it('is a pure function of its key — any roll is evaluable without its predecessors', () => {
    const key = { seed: 'abc', seq: 17, actor: 'A' as const, attempt: 0 }
    const first = rollDie(key, 6)
    for (let i = 0; i < 50; i++) expect(rollDie(key, 6)).toBe(first)

    // The property that matters for Phase 5: evaluating seq 17 never required seq 0..16.
    expect(rollDie({ ...key, seq: 18 }, 6)).toBeTypeOf('number')
  })

  it('separates every component of the key', () => {
    const base = { seed: 's', seq: 1, actor: 'A' as const, attempt: 0 }
    const variants = [
      rollDie(base, 1000),
      rollDie({ ...base, seed: 't' }, 1000),
      rollDie({ ...base, seq: 2 }, 1000),
      rollDie({ ...base, actor: 'B' }, 1000),
      rollDie({ ...base, attempt: 1 }, 1000),
    ]
    // Not a strict guarantee for any single pair, but five identical values out of 1000 sides
    // would mean the key components are not reaching the mixer at all.
    expect(new Set(variants).size).toBeGreaterThan(3)
  })

  it('is uniform enough that nobody can argue about the dice', () => {
    const counts = new Array<number>(6).fill(0)
    const n = 60_000
    for (let seq = 0; seq < n; seq++) {
      counts[rollDie({ seed: 'uniformity', seq, actor: 'A', attempt: 0 }, 6) - 1]!++
    }
    // Rejection sampling, not modulo: the expected count is exactly n/6 and the tolerance
    // below is ~4 standard deviations.
    for (const c of counts) expect(Math.abs(c - n / 6)).toBeLessThan(500)
  })

  it('stays in range for multi-die rolls', () => {
    for (let seq = 0; seq < 500; seq++) {
      const total = rollDice({ seed: 'range', seq, actor: 'B', attempt: 0 }, 3, 6)
      expect(total).toBeGreaterThanOrEqual(3)
      expect(total).toBeLessThanOrEqual(18)
    }
  })

  it('refuses a nonsensical die rather than inventing a value', () => {
    expect(() => rollDie({ seed: 's', seq: 0, actor: 'A', attempt: 0 }, 0)).toThrow(RangeError)
    expect(() => rollDie({ seed: 's', seq: 0, actor: 'A', attempt: 0 }, 2.5)).toThrow(RangeError)
  })
})

describe('canonical serialization', () => {
  it('is insensitive to key order and sensitive to values', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }))
  })

  it('preserves array order, because slot order is meaningful (§5)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('omits undefined members, matching the redaction shape', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('refuses values with no canonical JSON form rather than writing null into a hash', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson({ n: Infinity })).toThrow(TypeError)
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
  })
})
