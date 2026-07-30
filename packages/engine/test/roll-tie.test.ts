import { describe, expect, it } from 'vitest'

import { baseMode } from '@banpick/engine'

import { rollDice } from '../src/rng.js'
import { driveUntil, startMatch } from './helpers.js'

/**
 * `onTie: REROLL`, and the record it leaves behind.
 *
 * A tie is about one roll in six at 1d6 — common enough that a player sees several a session,
 * and the single most dramatic thing that happens in a match. The event therefore records
 * **every** throw, not just the decisive one, so a client can replay the tie rather than
 * summarising it as "2 attempts".
 *
 * These tests are seeded to tie. A seed that happens not to tie would make every assertion below
 * vacuous while still passing, so the seed is *searched for* rather than picked and hoped over —
 * and `findTieSeed` failing is itself a real failure, because it would mean ties had stopped
 * happening at the expected rate.
 */

const DICE = { count: 1, sides: 6 }

/** The tie/no-tie decision for one candidate seed at one `seq`, straight from the RNG. */
function throwsFor(seed: string, seq: number): { A: number; B: number }[] {
  const out: { A: number; B: number }[] = []
  for (let attempt = 0; attempt < 64; attempt++) {
    const A = rollDice({ seed, seq, actor: 'A', attempt }, DICE.count, DICE.sides)
    const B = rollDice({ seed, seq, actor: 'B', attempt }, DICE.count, DICE.sides)
    out.push({ A, B })
    if (A !== B) return out
  }
  throw new Error('unreachable')
}

/** The first seed in a deterministic sweep whose roll at `seq` needs at least `ties` rerolls. */
function findTieSeed(seq: number, ties: number): string {
  for (let i = 0; i < 200_000; i++) {
    const seed = `tie-search-${i}`
    if (throwsFor(seed, seq).length === ties + 1) return seed
  }
  throw new Error(`no seed in 200k produced ${ties} tie(s) at seq ${seq}`)
}

describe('the RNG ties, and the reroll is a fresh attempt', () => {
  it('ties at roughly one throw in six', () => {
    // The rate is what makes the animation worth building. If a change to the RNG made ties
    // vanish or dominate, everything downstream would still "work" and be wrong.
    let tied = 0
    const N = 6000
    for (let i = 0; i < N; i++) {
      const A = rollDice({ seed: `rate-${i}`, seq: 3, actor: 'A', attempt: 0 }, 1, 6)
      const B = rollDice({ seed: `rate-${i}`, seq: 3, actor: 'B', attempt: 0 }, 1, 6)
      if (A === B) tied++
    }
    expect(tied / N).toBeGreaterThan(0.13)
    expect(tied / N).toBeLessThan(0.2)
  })

  it('gives a different result on the next attempt, without stream state', () => {
    const seed = findTieSeed(3, 1)
    const [first, second] = throwsFor(seed, 3)
    expect(first!.A).toBe(first!.B)
    expect(second!.A).not.toBe(second!.B)

    // The reroll is keyed by `attempt`, so it is reproducible in isolation — evaluating it does
    // not require having evaluated the tie first (D9).
    expect(rollDice({ seed, seq: 3, actor: 'A', attempt: 1 }, 1, 6)).toBe(second!.A)
  })
})

describe('a tied roll reaches the log as every throw', () => {
  /** Plays `base` to its first roll on a given seed and returns the recorded ROLL payload. */
  function rollPayloadOn(seed: string) {
    // Stops once the roll has *landed*, not when the cursor reaches it — `driveUntil` checks
    // its condition before stepping, so `atModule` would halt one event too early.
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4, seed }),
      (s) => s.rounds[0]?.roll != null,
    )
    const event = state.log.find((e) => e.payload.type === 'ROLL')
    expect(event, 'no ROLL in the log').toBeTruthy()
    const payload = event!.payload
    if (payload.type !== 'ROLL') throw new Error('not a ROLL')
    return payload
  }

  it('records the tie and the throw that broke it', () => {
    // Find the seq the roll lands on for this mode, then search for a seed that ties there.
    const probe = rollPayloadOn('probe')
    const seq = probeSeq()
    const seed = findTieSeed(seq, 1)
    expect(probe.throws.length).toBeGreaterThanOrEqual(1) // the probe itself is well-formed

    const payload = rollPayloadOn(seed)
    expect(payload.attempts).toBe(2)
    expect(payload.throws).toHaveLength(2)
    expect(payload.throws[0]!.A).toBe(payload.throws[0]!.B)
    expect(payload.throws[1]!.A).not.toBe(payload.throws[1]!.B)

    // `results` stays the decisive throw — adding `throws` must not have changed what the rest
    // of the engine reads.
    expect(payload.results).toEqual(payload.throws[1])
    expect(payload.winner).toBe(payload.results.A > payload.results.B ? 'A' : 'B')
  })

  it('survives two consecutive ties', () => {
    const seed = findTieSeed(probeSeq(), 2)
    const payload = rollPayloadOn(seed)
    expect(payload.throws).toHaveLength(3)
    expect(payload.attempts).toBe(3)
    for (const t of payload.throws.slice(0, 2)) expect(t.A).toBe(t.B)
  })

  it('records a single throw when the first roll decides it', () => {
    // The common case must not carry a phantom extra entry: a one-throw roll animates as one
    // throw, with no tie beat.
    const seq = probeSeq()
    const clean = (() => {
      for (let i = 0; i < 200_000; i++) {
        const seed = `clean-search-${i}`
        if (throwsFor(seed, seq).length === 1) return seed
      }
      throw new Error('no clean seed found')
    })()

    const payload = rollPayloadOn(clean)
    expect(payload.throws).toHaveLength(1)
    expect(payload.attempts).toBe(1)
    expect(payload.throws[0]).toEqual(payload.results)
  })

  /**
   * The `seq` the first roll lands on.
   *
   * Derived by playing a match rather than hardcoded: it is the append index of the ROLL event,
   * which moves if the program before it ever gains a step. A hardcoded 3 here would turn every
   * tie assertion above into a test of an unrelated roll the moment that happened.
   */
  function probeSeq(): number {
    const state = driveUntil(
      startMatch({ mode: baseMode, draftCount: 4, seed: 'probe' }),
      (s) => s.rounds[0]?.roll != null,
    )
    return state.log.find((e) => e.payload.type === 'ROLL')!.seq
  }
})
