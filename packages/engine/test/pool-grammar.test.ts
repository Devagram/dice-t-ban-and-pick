import { describe, expect, it } from 'vitest'
import {
  baseMode,
  bringBan1Mode,
  charPool,
  legalDraftPoolExpr,
  legalMetaBanPoolExpr,
  legalRoundBanExpr,
  legalRoundPickExpr,
  repickTriggerExpr,
  ModeResolutionError,
  resolveMode,
  slotPool,
} from '@banpick/engine'
import type { CharSetExpr } from '@banpick/engine'

import { apply, atModule, driveUntil, startMatch } from './helpers.js'

/** The resolution failure's code, which is what the loader maps onto §13's error codes. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof ModeResolutionError) return e.code
    throw e
  }
  throw new Error('expected a ModeResolutionError, but nothing was thrown')
}

/**
 * Spec §6 and delivery-plan 1.3 — **the pool grammar is set algebra, not five functions.**
 *
 * The plan states the test for whether that was done honestly: *"adding D12's `selfDuplicates`
 * constraint should be a new term in an expression, not a new `if`."*
 *
 * So the first assertion below compares the two expression trees structurally. If someone
 * later implements a constraint as a branch inside the evaluator, the trees stop differing and
 * this fails — which is the only way a claim like "it's really set algebra" can be checked by
 * anything other than a reviewer's patience.
 */

describe('D12 lands as a term, not an `if`', () => {
  const forbidden = legalDraftPoolExpr({
    crossSeatMirrors: 'ALLOWED',
    selfDuplicates: 'FORBIDDEN',
  })
  const allowed = legalDraftPoolExpr({
    crossSeatMirrors: 'ALLOWED',
    selfDuplicates: 'ALLOWED',
  })

  it('differs from the unconstrained pool by exactly one subtrahend', () => {
    expect(forbidden.op).toBe('DIFF')
    expect(allowed.op).toBe('DIFF')

    const f = forbidden as Extract<CharSetExpr, { op: 'DIFF' }>
    const a = allowed as Extract<CharSetExpr, { op: 'DIFF' }>

    expect(f.from).toEqual(a.from)
    expect(f.minus).toHaveLength(a.minus.length + 1)
    // The shared prefix is identical — the constraint is appended, it does not rewrite.
    expect(f.minus.slice(0, a.minus.length)).toEqual(a.minus)
    expect(f.minus.at(-1)).toEqual({ op: 'SELF_HELD_OTHER_SLOTS' })
  })

  it('is slot-indexed, so a recommit may re-select its own slot', () => {
    // §6 is explicit: "during a CONDITIONAL_RECOMMIT a slot must not exclude the character it
    // currently holds — otherwise a repick of slot 1 would be forbidden from re-selecting what
    // slot 1 already had, which is a different rule than the one D12 states."
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'draft',
      seat: 'A',
      picks: ['anvil', 'cartographer', 'duelist', 'gambler'],
      metaBan: null,
    })

    const ctx = { state, seat: 'A' as const, roundIndex: null }
    const forSlot1 = charPool('legalDraftPool', { ...ctx, slotIndex: 1 })

    expect(forSlot1).toContain('cartographer') // slot 1's own character
    expect(forSlot1).not.toContain('anvil') // held in another slot
    expect(forSlot1).not.toContain('duelist')
  })
})

describe('the five named pools of §6', () => {
  it('legalMetaBanPool is activeRoster minus globalBanned, and nothing else', () => {
    const expr = legalMetaBanPoolExpr() as Extract<CharSetExpr, { op: 'DIFF' }>
    expect(expr.from).toEqual({ op: 'ACTIVE_ROSTER' })
    expect(expr.minus).toEqual([{ op: 'GLOBAL_BANNED' }])
  })

  it('legalRoundBan is the opponent’s unconsumed slots (D3)', () => {
    expect(legalRoundBanExpr()).toEqual({
      op: 'FILTER',
      from: { op: 'OPPONENT_SLOTS' },
      where: [{ p: 'UNCONSUMED' }],
    })
  })

  it('legalRoundPick excludes both consumed slots and this round’s ban', () => {
    expect(legalRoundPickExpr()).toEqual({
      op: 'FILTER',
      from: { op: 'OWN_SLOTS' },
      where: [{ p: 'UNCONSUMED' }, { p: 'NOT_BANNED_THIS_ROUND' }],
    })
  })

  it('repickTrigger matches on character, which is what makes blast radius a design question', () => {
    expect(repickTriggerExpr()).toEqual({
      op: 'FILTER',
      from: { op: 'OWN_SLOTS' },
      where: [{ p: 'CHARACTER_IN', set: { op: 'META_BANNED_AGAINST' } }],
    })
  })

  it('a round ban denies a slot for that round only', () => {
    let state = startMatch({ mode: baseMode, draftCount: 4 })
    state = driveUntil(state, atModule('rounds.0.ban'))

    const banner = state.rounds[0]!.privilegeHolder!
    const victim = banner === 'A' ? ('B' as const) : ('A' as const)
    const target = slotPool('legalRoundBan', {
      state,
      seat: banner,
      slotIndex: null,
      roundIndex: 0,
    })[0]!

    state = apply(state, banner, {
      type: 'BAN',
      moduleId: 'rounds.0.ban',
      roundIndex: 0,
      seat: banner,
      tier: 'ROUND',
      target: { seat: victim, slotIndex: target.index },
    })

    const ctx = { state, seat: victim, slotIndex: null }
    // Denied this round...
    expect(slotPool('legalRoundPick', { ...ctx, roundIndex: 0 }).map((s) => s.index)).not.toContain(
      target.index,
    )
    // ...and available again next round. D3: round-scoped, not permanent.
    expect(slotPool('legalRoundPick', { ...ctx, roundIndex: 1 }).map((s) => s.index)).toContain(
      target.index,
    )
  })

  it('refuses to evaluate a character pool as slots, and vice versa', () => {
    const state = startMatch({ mode: baseMode, draftCount: 4 })
    const ctx = { state, seat: 'A' as const, slotIndex: null, roundIndex: null }
    expect(() => charPool('legalRoundBan', ctx)).toThrow(TypeError)
    expect(() => slotPool('legalDraftPool', ctx)).toThrow(TypeError)
  })
})

describe('mode resolution', () => {
  it('flattens the round loop into a linear program with stable ids', () => {
    const resolved = resolveMode(baseMode, { draftCount: 4 })
    const ids = resolved.program.map((m) => m.id)

    expect(ids[0]).toBe('draft')
    // Round 0 keeps the full template.
    expect(ids).toContain('rounds.0.roll')
    expect(ids).toContain('rounds.0.privilegeChoice')
    // Round 1 drops the roll and the privilege choice, and gains the D10 inversion.
    expect(ids).not.toContain('rounds.1.roll')
    expect(ids).not.toContain('rounds.1.privilegeChoice')
    expect(ids).toContain('rounds.1.invert')
    // Round 2 drops the privilege choice and the ban, keeps its roll, and merges the selects.
    expect(ids).toContain('rounds.2.roll')
    expect(ids).not.toContain('rounds.2.privilegeChoice')
    expect(ids).not.toContain('rounds.2.ban')
    expect(ids).toContain('rounds.2.select')

    // D24's declareOrder survives in every round — removing "the CHOOSE" by type would have
    // taken it with the privilege choice.
    for (const r of [0, 1, 2]) expect(ids).toContain(`rounds.${r}.declareOrder`)
  })

  it('resolves ${draftCount} in both the label and the pick count (D25)', () => {
    for (const draftCount of [3, 4] as const) {
      const resolved = resolveMode(baseMode, { draftCount })
      expect(resolved.label).toBe(`Standard Bo3 — draft ${draftCount}`)
      const draft = resolved.program[0] as { commits: { picks: { count: number } } }
      expect(draft.commits.picks.count).toBe(draftCount)
      expect(resolved.parameters['draftCount']).toBe(draftCount)
    }
  })

  it('applies the parameter to bring-ban1 too, which the spec had hardcoded at 4', () => {
    // Found by id, not by position: bring-ban1 opens on its ban phase now, and `program[0]`
    // silently became the wrong module rather than a missing one.
    const resolved = resolveMode(bringBan1Mode, { draftCount: 3 })
    const draft = resolved.program.find((m) => m.id === 'draft') as {
      commits: { picks: { count: number } }
    }
    expect(draft.commits.picks.count).toBe(3)
  })

  it('binds reveal tags so a commit seals itself with the tag that will open it', () => {
    const base = resolveMode(baseMode, { draftCount: 4 })
    expect((base.program[0] as { revealTags: { picks: string } }).revealTags.picks).toBe(
      'draft:reveal',
    )

    // bring-ban1 splits the two across three modules: the ban opens at its own gate, the draft
    // defers to a later REVEAL. Each commit still seals itself with the tag that will open it,
    // which is the invariant — the module it belongs to is incidental.
    const hidden = resolveMode(bringBan1Mode, { draftCount: 4 })
    const ban = hidden.program.find((m) => m.id === 'ban') as {
      revealTags: { metaBan: string }
    }
    const hiddenDraft = hidden.program.find((m) => m.id === 'draft') as {
      revealTags: { picks: string }
    }
    expect(ban.revealTags.metaBan).toBe('ban:reveal') // gate one
    expect(hiddenDraft.revealTags.picks).toBe('pickReveal:reveal') // gate two
  })

  it('refuses a parameter value outside the declared space (D25)', () => {
    // The code, not just the class: Phase 2's loader maps these onto §13's load-error codes, so
    // a failure fixture is only meaningful if the reason survives the boundary.
    expect(() => resolveMode(baseMode, { draftCount: 5 })).toThrow(ModeResolutionError)
    expect(codeOf(() => resolveMode(baseMode, { draftCount: 5 }))).toBe('PARAMETER_INVALID')
    expect(codeOf(() => resolveMode(baseMode, { notADeclaredParam: 1 }))).toBe('PARAMETER_INVALID')
  })

  it('refuses a deferred reveal with no downstream gate (§13 reveal reachability)', () => {
    // A sealed slice with no gate is sealed forever. Phase 2's loader reports this as
    // REVEAL_UNREACHABLE; here it is a throw at resolution, which is the same moment.
    const broken = {
      ...bringBan1Mode,
      modules: bringBan1Mode.modules.filter((m) => m.id !== 'pickReveal'),
    }
    expect(codeOf(() => resolveMode(broken, { draftCount: 4 }))).toBe('REVEAL_UNREACHABLE')
  })

  it('refuses an override that removes a module the template does not define', () => {
    const broken = {
      ...baseMode,
      modules: baseMode.modules.map((m) =>
        m.type === 'ROUND_LOOP' ? { ...m, overrides: { 1: { remove: ['nope'] } } } : m,
      ),
    }
    expect(codeOf(() => resolveMode(broken, { draftCount: 4 }))).toBe('REMOVE_UNKNOWN_MODULE')
  })
})
