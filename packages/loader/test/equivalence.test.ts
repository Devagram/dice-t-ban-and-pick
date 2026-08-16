import { describe, expect, it } from 'vitest'
import { baseMode, bo1Bring3Ban1Mode, bringBan1Mode, resolveMode } from '@banpick/engine'
import { canonicalJson, type ModeDefinition } from '@banpick/types'
import { defaultVariant, variantFor } from '@banpick/loader'

import { loadShipped } from './helpers.js'

/**
 * **The Phase 2 exit criterion, and the point of the architecture.**
 *
 * "`loadMode('base.yaml', { draftCount: 4 })` produces a module list deep-equal to Phase 1's
 * hand-built equivalent, and the same holds at `draftCount: 3`."
 *
 * §1 requires that new modes are config and never engine code. Phase 1 built both shipped modes
 * programmatically; if the YAML produces the same programs, the claim holds. If it did not, the
 * gap would be a finding about the module boundary rather than something to patch.
 */

const PAIRS: [name: string, code: ModeDefinition][] = [
  ['base', baseMode],
  ['bring-ban1', bringBan1Mode],
  // D36. Parameterless, so its only combination is the empty one — hence the parameter space
  // driving the loop below rather than a hardcoded [3, 4].
  ['bo1-bring3-ban1', bo1Bring3Ban1Mode],
]

/** Every combination the mode declares, which for a parameterless mode is exactly one: none. */
function combinationsOf(mode: ModeDefinition): Record<string, string | number>[] {
  const names = Object.keys(mode.parameters)
  if (names.length === 0) return [{}]
  return names.reduce<Record<string, string | number>[]>(
    (acc, name) =>
      acc.flatMap((base) => mode.parameters[name]!.values.map((v) => ({ ...base, [name]: v }))),
    [{}],
  )
}

describe('YAML equals code', () => {
  for (const [name, code] of PAIRS) {
    for (const parameters of combinationsOf(code)) {
      it(`${name} at ${JSON.stringify(parameters)} resolves identically`, () => {
        const fromYaml = variantFor(loadShipped(name), parameters).mode
        const fromCode = resolveMode(code, parameters)

        // Deep equality on the whole resolved mode: the program, the interpolated label, the
        // resolved parameters, and the tie and match rules.
        expect(canonicalJson(fromYaml)).toBe(canonicalJson(fromCode))
      })
    }

    it(`${name} declares the same parameter space in both`, () => {
      const loaded = loadShipped(name)
      expect(loaded.definition.parameters).toEqual(code.parameters)
      expect(loaded.modeId).toBe(code.modeId)
    })
  }

  it('resolves every declared combination, not just the default (D25)', () => {
    const loaded = loadShipped('base')
    expect(loaded.variants.map((v) => v.parameters)).toEqual([{ draftCount: 3 }, { draftCount: 4 }])
    expect(defaultVariant(loaded).parameters).toEqual({ draftCount: 4 })
  })

  it('refuses a combination it never validated', () => {
    // `variantFor` does not resolve on the fly. Every offerable combination was enumerated and
    // checked at load, so a lookup miss means the lobby is offering something unvalidated.
    expect(() => variantFor(loadShipped('base'), { draftCount: 5 })).toThrow(RangeError)
  })
})

describe('the flattened program', () => {
  it('has the D10/D11/D26 shape the spec describes', () => {
    const ids = variantFor(loadShipped('base'), { draftCount: 4 }).mode.program.map((m) => m.id)

    expect(ids[0]).toBe('draft')
    // Round 0 keeps the full template.
    expect(ids).toContain('rounds.0.roll')
    expect(ids).toContain('rounds.0.privilegeChoice')
    // Round 1 drops the roll and the choice, and gains the D10 inversion.
    expect(ids).not.toContain('rounds.1.roll')
    expect(ids).toContain('rounds.1.invert')
    // Round 2 keeps its roll, drops the choice and the ban, and merges the two selects.
    expect(ids).toContain('rounds.2.roll')
    expect(ids).not.toContain('rounds.2.ban')
    expect(ids).toContain('rounds.2.select')
    // D24's declareOrder survives every round — removing "the CHOOSE" by type would have taken
    // it along with the privilege choice.
    for (const r of [0, 1, 2]) expect(ids).toContain(`rounds.${r}.declareOrder`)
  })

  it('prepends bring-ban1’s ban phase, its draft, and the pick reveal', () => {
    const program = variantFor(loadShipped('bring-ban1'), { draftCount: 4 }).mode.program
    expect(program.slice(0, 3).map((m) => m.id)).toEqual(['ban', 'draft', 'pickReveal'])

    // Gate one: the ban, alone, opening at its own module.
    const ban = program[0]!
    expect(ban.type).toBe('SIMULTANEOUS_COMMIT')
    if (ban.type !== 'SIMULTANEOUS_COMMIT') return
    expect(ban.commits.metaBan).not.toBeNull()
    expect(ban.commits.picks).toBeNull()
    expect(ban.revealTags.metaBan).toBe('ban:reveal')

    // Gate two: the draft, sealed until a later REVEAL — and carrying no ban of its own, so the
    // ban cannot be re-placed once it is public.
    const draft = program[1]!
    expect(draft.type).toBe('SIMULTANEOUS_COMMIT')
    if (draft.type !== 'SIMULTANEOUS_COMMIT') return
    expect(draft.commits.picks).not.toBeNull()
    expect(draft.commits.metaBan).toBeNull()
    expect(draft.revealTags.picks).toBe('pickReveal:reveal')
  })

  it('resolves ${draftCount} in the label and the pick count', () => {
    for (const draftCount of [3, 4] as const) {
      const variant = variantFor(loadShipped('base'), { draftCount })
      expect(variant.mode.label).toBe(`Standard Bo3 — draft ${draftCount}`)
      const draft = variant.mode.program[0]!
      if (draft.type !== 'SIMULTANEOUS_COMMIT') throw new Error('expected the draft module first')
      expect(draft.commits.picks!.count).toBe(draftCount)
    }
  })
})
