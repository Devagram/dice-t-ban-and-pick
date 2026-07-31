import type { ModeDefinition } from '@banpick/types'

import {
  DRAFT_COUNT_PARAM,
  MATCH_RULE,
  OVERTIME_RULE,
  ROUND_LOOP,
  TIE_RULE,
} from './roundTemplate.js'

/**
 * Deliverable 1.6 — the two shipped modes, built programmatically.
 *
 * These move to YAML in Phase 2, and Phase 2's acceptance test is literally that
 * `loadMode('base.yaml', { draftCount: 4 })` produces a module list deep-equal to what
 * `resolveMode(baseMode, { draftCount: 4 })` produces here. Which makes these objects the
 * loader's specification, not a throwaway fixture.
 */

/** Spec §9.1. */
export const baseMode: ModeDefinition = {
  modeId: 'base',
  label: 'Standard Bo3 — draft ${draftCount}',
  parameters: { draftCount: DRAFT_COUNT_PARAM },
  modules: [
    {
      type: 'SIMULTANEOUS_COMMIT',
      id: 'draft',
      commits: {
        picks: { count: { param: 'draftCount' }, pool: 'legalDraftPool' },
        metaBan: null,
      },
      reveal: { picks: 'IMMEDIATE', metaBan: 'NONE' },
    },
    ROUND_LOOP,
  ],
  onTie: TIE_RULE,
  match: MATCH_RULE,
  overtime: OVERTIME_RULE,
}

/**
 * Spec §9.2 — identical to base with three modules prepended.
 *
 * Sequence: **ban first**, both blind → reveal both bans → draft against that knowledge (hidden)
 * → reveal picks → round loop.
 *
 * **The ban moved in front of the draft (2026-07-31), and that resolves O6.** It used to be
 * committed alongside the picks, which made it a guess about what the opponent had brought — at
 * a 45-character roster, `draftCount/45`, so roughly nine whiffs in ten. Banning first makes it
 * certain: the character leaves their pool before they choose.
 *
 * Two consequences, neither obvious:
 *
 *   - **`CONDITIONAL_RECOMMIT` is gone.** It existed only to repair a draft a blind ban had hit.
 *     Ban first and there is nothing to repair, so the module was removed rather than left as a
 *     no-op that would still have to be reasoned about.
 *   - **The pool needed no change.** `legalDraftPool` already subtracts `metaBannedAgainst[seat]`
 *     (see `pools.ts`); the term simply evaluated empty at draft time. §6's claim that "adding a
 *     mode should never require new pool code" held for a reordering it never anticipated.
 *
 * The ban stays `OPPONENT_ONLY` (D4): it removes the character from *them*, not from the match.
 * With mirrors allowed (D1) you may still draft what you banned, which is now a deliberate line
 * rather than an accident.
 */
export const bringBan1Mode: ModeDefinition = {
  modeId: 'bring-ban1',
  label: 'Bring ${draftCount}, Ban 1',
  parameters: { draftCount: DRAFT_COUNT_PARAM },
  modules: [
    {
      type: 'SIMULTANEOUS_COMMIT',
      id: 'ban',
      commits: {
        picks: null,
        metaBan: { count: 1, pool: 'legalMetaBanPool', tier: 'META', targets: 'OPPONENT_ONLY' },
      },
      reveal: { picks: 'NONE', metaBan: 'IMMEDIATE' },
    },
    {
      type: 'SIMULTANEOUS_COMMIT',
      id: 'draft',
      commits: {
        // The spec hardcoded 4 here while declaring the parameter — reconciled 2026-07-28.
        picks: { count: { param: 'draftCount' }, pool: 'legalDraftPool' },
        metaBan: null,
      },
      reveal: { picks: 'DEFERRED', metaBan: 'NONE' },
    },
    { type: 'REVEAL', id: 'pickReveal', slices: ['slots'] },
    ROUND_LOOP,
  ],
  onTie: TIE_RULE,
  match: MATCH_RULE,
  overtime: OVERTIME_RULE,
}

export const MODES: Record<string, ModeDefinition> = {
  base: baseMode,
  'bring-ban1': bringBan1Mode,
}

export * from './roundTemplate.js'
