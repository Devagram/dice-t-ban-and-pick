import { describe, expect, it } from 'vitest'
import {
  loadModeFromSource,
  ModeLoadError,
  PARAMETER_SPACE_CAP,
  validateTermination,
  type LoadErrorCode,
} from '@banpick/loader'
import type { MatchRule, OvertimeRule, Roster, TieRule } from '@banpick/types'

import { loadShipped, modeSource, mutate, removeModule, ROSTER_10 } from './helpers.js'

/**
 * The failure fixture suite.
 *
 * "One intentionally malformed mode per validator, each failing with a distinct stable error
 * code." Every fixture below is a **surgical mutation of a shipped mode**, so it differs from a
 * passing file by exactly the thing under test. Hand-written broken files drift from the real
 * ones and eventually fail for reasons nobody intended.
 *
 * The point of all of this is stated in §13: a mode that cannot finish should fail at load,
 * naming the rule it broke — never at 1.5–1.5 in front of two players.
 */

function expectLoadFailure(source: string, ref: string, roster: Roster = ROSTER_10): ModeLoadError {
  try {
    loadModeFromSource(source, ref, { roster })
  } catch (e) {
    if (e instanceof ModeLoadError) return e
    throw e
  }
  throw new Error(`${ref} loaded successfully; the fixture is no longer malformed`)
}

function expectCode(source: string, code: LoadErrorCode, ref = 'fixture'): ModeLoadError {
  const error = expectLoadFailure(source, ref)
  expect(error.codes, `expected ${code}, got [${error.codes.join(', ')}]`).toContain(code)
  return error
}

describe('the shipped modes load', () => {
  it('base and bring-ban1 both pass every validator', () => {
    expect(() => loadShipped('base')).not.toThrow()
    expect(() => loadShipped('bring-ban1')).not.toThrow()
  })
})

describe('YAML_PARSE', () => {
  it('rejects a file that is not YAML', () => {
    expectCode('mode: base\n  bad: [indent', 'YAML_PARSE')
  })

  it('rejects a file that is not a mapping', () => {
    expectCode('- just\n- a\n- list\n', 'YAML_PARSE')
  })
})

describe('SCHEMA_VERSION', () => {
  it('refuses a file written against a schema this loader does not implement', () => {
    // Checked before shape, so a future file gets a useful answer rather than a pile of errors
    // about rules it was never written against.
    const error = expectCode(
      mutate('base', [['schemaVersion: 1', 'schemaVersion: 2']]),
      'SCHEMA_VERSION',
    )
    expect(error.issues[0]!.message).toContain('this loader implements 1')
  })
})

describe('SCHEMA_INVALID', () => {
  it('rejects an unknown module type', () => {
    expectCode(mutate('base', [['use: BAN', 'use: TELEPORT']]), 'SCHEMA_INVALID')
  })

  it('rejects an unknown pool name', () => {
    expectCode(mutate('base', [['pool: legalRoundBan', 'pool: whateverIWant']]), 'SCHEMA_INVALID')
  })

  it('rejects a scoring rule D21 cut', () => {
    // The schema is the first gate on the tie rules; `validateTermination` is the second. Both
    // exist because the schema constrains what can be *written* and the validator constrains
    // what can be *combined*.
    expectCode(mutate('base', [['scoring: HALF_POINT', 'scoring: COMPENSATION']]), 'SCHEMA_INVALID')
  })

  it('rejects a stray key rather than ignoring it', () => {
    // A typo in a mode file that silently does nothing is worse than one that fails: the mode
    // runs, and it runs subtly differently from what its author read.
    expectCode(
      mutate('base', [['    onTie: REROLL', '    onTie: REROLL\n        rerolls: 3']]),
      'SCHEMA_INVALID',
    )
  })
})

describe('DUPLICATE_MODULE_ID', () => {
  it('rejects two modules sharing an id, because `remove` names ids', () => {
    expectCode(mutate('base', [['id: declareOrder', 'id: ban']]), 'DUPLICATE_MODULE_ID')
  })
})

describe('SLICE_DEPENDENCY', () => {
  it('rejects a program whose ban reads slots nothing wrote', () => {
    // Deleting the draft leaves BAN and SELECT reading `slots` with no upstream writer. This is
    // the validator that catches a mode assembled in the wrong order.
    expectCode(removeModule('base', 'draft'), 'SLICE_DEPENDENCY')
  })
})

describe('ROSTER_VIABILITY', () => {
  it('rejects a roster too small for the draft plus a meta ban', () => {
    // §13's floor is `draftCount + 1`, derived: a repicking seat needs `draftCount` distinct
    // characters (D12) and has one denied to it. At draftCount 4 that is 5.
    const tiny: Roster = {
      rosterVersion: '2026.01.01-1',
      characters: ROSTER_10.characters.slice(0, 4),
    }
    const error = expectLoadFailure(modeSource('base'), 'modes/base.yaml', tiny)
    expect(error.has('ROSTER_VIABILITY')).toBe(true)
    expect(error.message).toContain('needs at least 5')
  })

  it('accepts a roster that clears the floor for every declared parameter value', () => {
    // Five characters is enough at draftCount 4, so it is enough at 3 too — but the loader
    // checks the binding case for *every* value rather than assuming the default is worst.
    const five: Roster = {
      rosterVersion: '2026.01.01-1',
      characters: ROSTER_10.characters.slice(0, 5),
    }
    expect(() => loadModeFromSource(modeSource('base'), 'base', { roster: five })).not.toThrow()
  })
})

describe('REVEAL_UNREACHABLE', () => {
  it('rejects a deferred reveal with no downstream gate', () => {
    // bring-ban1 defers picks to gate two. Delete the gate and the slice is sealed forever —
    // which would surface as two players staring at a screen that never advances.
    expectCode(removeModule('bring-ban1', 'pickReveal'), 'REVEAL_UNREACHABLE')
  })
})

describe('TRANSITION_REMOVED', () => {
  it('rejects an override that removes the result report', () => {
    // D13's principle: `remove` may delete a decision, never a transition the round cannot
    // complete without. REPORT_RESULT produces the result the match rule scores.
    const error = expectCode(
      mutate('base', [
        [
          '        remove: [roll, privilegeChoice]',
          '        remove: [roll, privilegeChoice, report]',
        ],
      ]),
      'TRANSITION_REMOVED',
    )
    expect(error.message).toContain('auto-commits (D26)')
  })

  it('rejects an override that removes a select', () => {
    // This is the original bug D13 was written about: a SELECT that vanishes leaves `consumed`
    // untouched and the replay with no record that the slot was played.
    expectCode(
      mutate('base', [
        [
          '        remove: [privilegeChoice, ban]',
          '        remove: [privilegeChoice, ban, selectFirst]',
        ],
      ]),
      'TRANSITION_REMOVED',
    )
  })

  it('allows removing the ban, which round 2 legitimately does', () => {
    // §13 words this validator as "may not name a module that writes a state slice". Taken
    // literally it rejects the shipped base mode, because BAN writes `bannedInRound` and round
    // 2 has no ban (D11). Nothing is left un-transitioned, so it loads.
    expect(() => loadShipped('base')).not.toThrow()
  })
})

describe('PARAMETER_SPACE', () => {
  it('rejects a default that is not among the declared values', () => {
    expectCode(mutate('base', [['    default: 4', '    default: 9']]), 'PARAMETER_SPACE')
  })

  it('rejects a parameter space too large to check exhaustively', () => {
    const many = Array.from({ length: PARAMETER_SPACE_CAP + 2 }, (_, i) => i + 3).join(', ')
    const error = expectCode(
      mutate('base', [['    values: [3, 4]', `    values: [${many}]`]]),
      'PARAMETER_SPACE',
    )
    expect(error.message).toContain('validated only for its defaults')
  })

  it('validates every combination, not just the default', () => {
    // draftCount 4 clears a 5-character roster; draftCount 3 clears a 4-character one. With a
    // 4-character roster the *default* passes and the other value does not — exactly the case
    // D25's validator exists to catch.
    const four: Roster = {
      rosterVersion: '2026.01.01-1',
      characters: ROSTER_10.characters.slice(0, 4),
    }
    const error = expectLoadFailure(modeSource('base'), 'modes/base.yaml', four)
    expect(error.has('ROSTER_VIABILITY')).toBe(true)
    // Only the draftCount=4 variant fails; the report names which one.
    expect(error.message).toContain('draftCount=4')
    expect(error.message).not.toContain('draftCount=3')
  })
})

describe('NON_TERMINATING', () => {
  /**
   * Unreachable through YAML on purpose: the schema pins `scoring`, `resolution`, and
   * `overtime.enabled` to single values, so the only document it accepts is the terminating
   * one. The validator is the second gate, and it is tested at its own level rather than
   * through a fixture the schema would reject first.
   *
   * G14's example is the reason it exists at all.
   */
  const terminating: [TieRule, MatchRule, OvertimeRule] = [
    { scoring: 'HALF_POINT', consumesCharacters: true },
    { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true },
    { enabled: false },
  ]

  it('accepts the one shipped triple', () => {
    expect(validateTermination(...terminating, 'fixture')).toEqual([])
  })

  it('rejects HALF_POINT + FIRST_TO_2, which deadlocks at 1.5–1.5', () => {
    const issues = validateTermination(
      terminating[0],
      { resolution: 'FIRST_TO_2' as MatchRule['resolution'], stopWhenDecided: true },
      terminating[2],
      'fixture',
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('NON_TERMINATING')
    expect(issues[0]!.message).toContain('provably terminating')
  })

  it('rejects a scoring rule D21 cut', () => {
    const issues = validateTermination(
      { scoring: 'COMPENSATION' as TieRule['scoring'], consumesCharacters: true },
      terminating[1],
      terminating[2],
      'fixture',
    )
    expect(issues[0]!.code).toBe('NON_TERMINATING')
  })
})

describe('a failure names every rule it broke, not just the first', () => {
  it('reports all issues together', () => {
    // A loader that stops at the first problem turns fixing a mode into a guessing loop.
    const broken = mutate('base', [
      ['    default: 4', '    default: 9'],
      [
        '        remove: [roll, privilegeChoice]',
        '        remove: [roll, privilegeChoice, report]',
      ],
    ])
    const error = expectLoadFailure(broken, 'fixture')
    expect(error.has('PARAMETER_SPACE')).toBe(true)
    expect(error.has('TRANSITION_REMOVED')).toBe(true)
  })
})
