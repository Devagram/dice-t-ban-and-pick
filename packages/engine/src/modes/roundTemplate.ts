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
  {
    type: 'BAN',
    id: 'ban',
    tier: 'ROUND',
    mode: 'SEQUENTIAL',
    actor: 'privilegeHolder',
    pool: 'legalRoundBan',
  },
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

  /*
   * D30 — the tiebreaker, reached only from 1.5-1.5 with a character still in hand.
   *
   * Round 2's shape, because that is what the situation has become: one character each, so
   * nothing to ban and nothing to choose between. What still matters is the roll and D24's
   * declaration of play order, which in Dice Throne is most of a match-up anyway.
   *
   * `allowTie: false` is the part that is not round 2. A tiebreaker that can tie ends 2.0-2.0
   * with an empty board, and G14 refuses that combination for good reason — the loader checks
   * for this flag rather than trusting the mode author, see `validateTermination`.
   */
  3: {
    remove: ['privilegeChoice', 'ban'],
    rollAssigns: 'TURN_ORDER',
    select: { mode: 'SIMULTANEOUS_HIDDEN', actor: 'BOTH', pool: 'legalRoundPick' },
    report: { allowTie: false },
  },
}

export const ROUND_LOOP: RoundLoopSpec = {
  type: 'ROUND_LOOP',
  id: 'rounds',
  count: 3,
  template: ROUND_TEMPLATE,
  overrides: ROUND_OVERRIDES,
}

/**
 * Spec §10, D21, and D30's amendment.
 *
 * HALF_POINT scoring over three rounds, and a draw is still a legal terminal state — at
 * `draftCount: 3` it is the only thing 1.5-1.5 can be. At 4 the overtime round decides it.
 */
export const TIE_RULE: TieRule = { scoring: 'HALF_POINT', consumesCharacters: true }
export const MATCH_RULE: MatchRule = { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true }
export const OVERTIME_RULE: OvertimeRule = { enabled: true }

// --- D36: the single game ----------------------------------------------------------------------

/**
 * One round, both seats banning at once, and the higher roll playing first.
 *
 * Not a variation on `ROUND_TEMPLATE`: almost everything that template carries exists to
 * distribute an asymmetric ban fairly across three rounds — the roll for privilege (D2), the
 * round-1 inversion (D10), the alternating select order (§9.3). Over a single game none of it has
 * anywhere to balance out, so the ban is symmetric and the roll does one job.
 *
 * **And that job is deciding play order, not handing out the right to decide it.** D23/D24 made
 * the declaration a real choice by deferring it until both picks were open — you may put yourself
 * second knowing the match-up. The owner's call for this format is the simpler table rule: high
 * roll goes first. So there is no `declareOrder` here, and the roll writes the answer itself
 * (`assigns: PLAY_ORDER`) rather than leaving the record silent about who started.
 *
 * The roll still sits *after* both hidden phases. Both the ban and the pick are better decisions
 * made without knowing who will go first.
 */
export const BO1_TEMPLATE: RoundModuleSpec[] = [
  {
    type: 'BAN',
    id: 'ban',
    tier: 'ROUND',
    mode: 'SIMULTANEOUS_HIDDEN',
    actor: 'BOTH',
    pool: 'legalRoundBan',
  },
  {
    type: 'SELECT',
    id: 'select',
    mode: 'SIMULTANEOUS_HIDDEN',
    actor: 'BOTH',
    pool: 'legalRoundPick',
  },
  {
    type: 'ROLL',
    id: 'roll',
    dice: { count: 1, sides: 6 },
    actors: 'BOTH',
    resolve: 'HIGHEST',
    assigns: 'PLAY_ORDER',
    onTie: 'REROLL',
  },
  { type: 'REPORT_RESULT', id: 'report', allowTie: true },
]

export const BO1_ROUND_LOOP: RoundLoopSpec = {
  type: 'ROUND_LOOP',
  id: 'rounds',
  count: 1,
  template: BO1_TEMPLATE,
  overrides: {},
}

/**
 * D36 — and `count: 1` above must agree with this, which the loader checks.
 *
 * Overtime is off. It fires when regulation ends level and both seats can still play, and after
 * one drawn round that is nearly always true — so it would not be a tiebreaker, it would be a
 * second round. A tied Bo1 is a drawn match, which is what HALF_POINT has meant since D21.
 */
export const BO1_MATCH_RULE: MatchRule = {
  resolution: 'ALWAYS_1_ROUND',
  stopWhenDecided: false,
}
export const BO1_OVERTIME_RULE: OvertimeRule = { enabled: false }

/** D25 — one parameter, declared by both modes. The 3-vs-4 question is settled by §15, not here. */
export const DRAFT_COUNT_PARAM = {
  values: [3, 4] as const,
  default: 4,
  label: 'Characters drafted',
}
