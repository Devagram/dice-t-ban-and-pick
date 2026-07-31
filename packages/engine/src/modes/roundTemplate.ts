import type {
  MatchRule,
  OvertimeRule,
  RoundIdx,
  RoundLoopSpec,
  RoundModuleSpec,
  RoundOverride,
  TieRule,
} from '@banpick/types'

/**
 * Spec §9.1's round loop, shared by both shipped modes.
 *
 * Every module carries an id — see the note in resolveMode.ts for why that is not cosmetic:
 * round 2's override removes "the CHOOSE", and there are two of them.
 */
export const ROUND_TEMPLATE: RoundModuleSpec[] = [
  {
    type: 'ROLL',
    id: 'roll',
    dice: { count: 1, sides: 6 },
    actors: 'BOTH',
    resolve: 'HIGHEST',
    onTie: 'REROLL',
    assigns: null,
  },
  {
    // D2 — one privilege to the roll winner, the complement to the loser.
    type: 'CHOOSE',
    id: 'privilegeChoice',
    actor: 'rollWinner',
    options: ['DRAFT_PRIVILEGE', 'TURN_ORDER'],
    loserGets: 'COMPLEMENT',
  },
  { type: 'BAN', id: 'ban', tier: 'ROUND', actor: 'privilegeHolder', pool: 'legalRoundBan' },
  {
    type: 'SELECT',
    id: 'selectFirst',
    mode: 'SEQUENTIAL',
    actor: 'opponent',
    pool: 'legalRoundPick',
  },
  {
    type: 'SELECT',
    id: 'selectSecond',
    mode: 'SEQUENTIAL',
    actor: 'privilegeHolder',
    pool: 'legalRoundPick',
  },
  {
    // D23/D24 — the turn-order holder declares play order *after* both picks are revealed, and
    // may put themselves second. Blind, it would be a coin flip with ceremony.
    type: 'CHOOSE',
    id: 'declareOrder',
    actor: 'turnOrderHolder',
    options: ['SELF_FIRST', 'OPPONENT_FIRST'],
    loserGets: null,
  },
  { type: 'REPORT_RESULT', id: 'report', allowTie: true },
]

export const ROUND_OVERRIDES: Partial<Record<RoundIdx, RoundOverride>> = {
  // D10 — round 1 is the mirror of round 0. No roll: both privileges invert.
  1: {
    remove: ['roll', 'privilegeChoice'],
    insert: [
      {
        type: 'ASSIGN',
        id: 'invert',
        privilegeHolder: 'INVERT_PREVIOUS',
        turnOrderHolder: 'INVERT_PREVIOUS',
      },
    ],
    /**
     * **The banned player picks first, in every round.**
     *
     * This used to read `['privilegeHolder', 'opponent']`, inverting round 0 so the *banner*
     * chose first here — §9.3 argued it as a counterweight, since round 1's ban bites harder.
     *
     * Changed 2026-07-31 on the owner's call, after playing it. The rule the table expects is
     * the simple one — you ban, they answer, you counter-pick — and having it reverse in the
     * middle round read as a bug rather than as compensation. Kept as an explicit override
     * rather than deleted, because saying it out loud is what stops it drifting back.
     */
    selectOrder: ['opponent', 'privilegeHolder'],
  },

  // D11 — no draft privilege exists in round 2, so the roll assigns turn order directly and
  // CHOOSE is removed rather than narrowed to one option.
  // D26 — and no branch on draftCount. At 4 each seat holds 2 unconsumed and picks for real;
  // at 3 each holds 1 and SELECT auto-commits. Same program.
  2: {
    remove: ['privilegeChoice', 'ban'],
    rollAssigns: 'TURN_ORDER',
    select: { mode: 'SIMULTANEOUS_HIDDEN', actor: 'BOTH', pool: 'legalRoundPick' },
  },
}

export const ROUND_LOOP: RoundLoopSpec = {
  type: 'ROUND_LOOP',
  id: 'rounds',
  count: 3,
  template: ROUND_TEMPLATE,
  overrides: ROUND_OVERRIDES,
}

/** Spec §10, D21. One rule ships: HALF_POINT, always 3 rounds, no overtime, draws are legal. */
export const TIE_RULE: TieRule = { scoring: 'HALF_POINT', consumesCharacters: true }
export const MATCH_RULE: MatchRule = { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true }
export const OVERTIME_RULE: OvertimeRule = { enabled: false }

/** D25 — one parameter, declared by both modes. The 3-vs-4 question is settled by §15, not here. */
export const DRAFT_COUNT_PARAM = {
  values: [3, 4] as const,
  default: 4,
  label: 'Characters drafted',
}
