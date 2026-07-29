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
 * Sequence: commit picks and ban (hidden) → **gate one** reveals bans only → repick banned
 * slots (hidden, conditional) → **gate two** reveals picks → round loop.
 *
 * On what the mode actually asks (O6): an opponent-only meta ban does not prevent a mirror, it
 * steals one — and at a ~75-character roster it hits about 5.3% of the time under uniform
 * drafting. Friends do not draft uniformly, so the real question is *"what do they always
 * play?"* rather than *"did they bring this?"*. §15's meta-ban hit rate is what decides whether
 * the mode earns its place.
 */
export const bringBan1Mode: ModeDefinition = {
  modeId: 'bring-ban1',
  label: 'Bring ${draftCount}, Ban 1',
  parameters: { draftCount: DRAFT_COUNT_PARAM },
  modules: [
    {
      type: 'SIMULTANEOUS_COMMIT',
      id: 'draft',
      commits: {
        // The spec hardcoded 4 here while declaring the parameter — reconciled 2026-07-28.
        picks: { count: { param: 'draftCount' }, pool: 'legalDraftPool' },
        metaBan: { count: 1, pool: 'legalMetaBanPool', tier: 'META', targets: 'OPPONENT_ONLY' },
      },
      reveal: { picks: 'DEFERRED', metaBan: 'IMMEDIATE' }, // gate one
    },
    {
      type: 'CONDITIONAL_RECOMMIT',
      id: 'repick',
      trigger: 'repickTrigger',
      pool: 'legalDraftPool',
      hidden: true,
    },
    { type: 'REVEAL', id: 'pickReveal', slices: ['slots'] }, // gate two
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
