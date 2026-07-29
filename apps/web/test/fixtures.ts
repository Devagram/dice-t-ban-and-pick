import type { Action, Character, PlayerView, Ruleset, Seat, Slot } from '@banpick/types'

/**
 * Fixtures built from the **wire types**, not from the engine.
 *
 * The client cannot import `@banpick/engine` (D18), so its tests must not either — a test that
 * reached for the engine to build a view would be testing a client that could not exist.
 */

export const ROSTER: Character[] = [
  ['anvil', 'The Anvil', 'Absorbs pressure and gives ground slowly.'],
  ['cartographer', 'The Cartographer', 'Trades early tempo for board knowledge.'],
  ['duelist', 'The Duelist', 'High variance, decides rounds quickly.'],
  ['gambler', 'The Gambler', 'Rewards risk, punishes hesitation.'],
  ['herald', 'The Herald', 'Strong opener, fades late.'],
  ['magpie', 'The Magpie', 'Takes what the opponent leaves behind.'],
  ['oracle', 'The Oracle', 'Information over force.'],
  ['sentinel', 'The Sentinel', 'Denies options rather than creating them.'],
].map(([id, name, blurb]) => ({ id: id!, name: name!, blurb: blurb!, status: 'ACTIVE' as const }))

export const RULESET: Ruleset = {
  modeId: 'base',
  parameters: { draftCount: 4 },
  rosterVersion: '2026.07.28-1',
  globalBanned: [],
  constraints: { crossSeatMirrors: 'ALLOWED', selfDuplicates: 'FORBIDDEN' },
  onTie: { scoring: 'HALF_POINT', consumesCharacters: true },
  match: { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true },
  overtime: { enabled: false },
  modeContentHash: 'abc123def456',
}

export function slot(index: 0 | 1 | 2 | 3, characterId: string, over: Partial<Slot> = {}): Slot {
  return { index, characterId, consumed: false, bannedInRound: null, ...over }
}

export function view(over: Partial<PlayerView> = {}): PlayerView {
  const seat: Seat = over.seat ?? 'A'
  return {
    status: 'IN_PROGRESS',
    seat,
    engineVersion: '0.1.0',
    ruleset: RULESET,
    mode: { modeId: 'base', label: 'Standard Bo3 — draft 4', parameters: { draftCount: 4 } },
    roster: ROSTER,
    you: {
      seat,
      score: 0,
      hasCommitted: true,
      slotCount: 4,
      slots: [slot(0, 'anvil'), slot(1, 'cartographer'), slot(2, 'duelist'), slot(3, 'gambler')],
    },
    opponent: {
      seat: seat === 'A' ? 'B' : 'A',
      score: 0,
      hasCommitted: true,
      slotCount: 4,
      slots: [slot(0, 'herald'), slot(1, 'magpie'), slot(2, 'oracle'), slot(3, 'sentinel')],
    },
    rounds: [0, 1, 2].map((index) => ({
      index: index as 0 | 1 | 2,
      privilegeHolder: null,
      turnOrderHolder: null,
      roll: null,
      ban: null,
      selection: {},
      selectionCommitted: { A: false, B: false },
      playOrder: null,
      result: null,
    })),
    phase: { moduleId: 'rounds.0.ban', type: 'BAN', roundIndex: 0, awaiting: [seat] },
    legalActions: [],
    outcome: null,
    seq: 12,
    ...over,
  }
}

/** A sealed opponent: §7 says the field is *absent*, not null and not flagged. */
export function sealedOpponent(): PlayerView['opponent'] {
  return { seat: 'B', score: 0, hasCommitted: true, slotCount: 4 }
}

export const BAN_ACTION: Extract<Action, { type: 'BAN' }> = {
  type: 'BAN',
  moduleId: 'rounds.0.ban',
  roundIndex: 0,
  tier: 'ROUND',
  targets: [
    { seat: 'B', slotIndex: 0 },
    { seat: 'B', slotIndex: 2 },
  ],
}

export const SELECT_ACTION: Extract<Action, { type: 'SELECT' }> = {
  type: 'SELECT',
  moduleId: 'rounds.0.selectFirst',
  roundIndex: 0,
  slots: [1, 3],
}

export const CHOOSE_PRIVILEGE: Extract<Action, { type: 'CHOOSE' }> = {
  type: 'CHOOSE',
  moduleId: 'rounds.0.privilegeChoice',
  roundIndex: 0,
  options: ['DRAFT_PRIVILEGE', 'TURN_ORDER'],
}

export const CHOOSE_ORDER: Extract<Action, { type: 'CHOOSE' }> = {
  type: 'CHOOSE',
  moduleId: 'rounds.0.declareOrder',
  roundIndex: 0,
  options: ['SELF_FIRST', 'OPPONENT_FIRST'],
}

export const REPORT_ACTION: Extract<Action, { type: 'REPORT_RESULT' }> = {
  type: 'REPORT_RESULT',
  moduleId: 'rounds.0.report',
  roundIndex: 0,
  outcomes: ['A', 'B', 'TIE'],
}

export const COMMIT_ACTION: Extract<Action, { type: 'COMMIT' }> = {
  type: 'COMMIT',
  moduleId: 'draft',
  picks: {
    count: 4,
    poolBySlot: [
      ROSTER.map((c) => c.id),
      ROSTER.map((c) => c.id),
      ROSTER.map((c) => c.id),
      ROSTER.map((c) => c.id),
    ],
  },
  metaBan: { count: 1, pool: ROSTER.map((c) => c.id) },
}
