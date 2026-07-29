import {
  ROUND_COUNT,
  publicSlice,
  isRoundIdx,
  type EventEnvelope,
  type MatchState,
  type PayloadOf,
  type RoundState,
} from '@banpick/types'

/** Bumped with the engine's `reduce` semantics, not with the package. Major = replay refuses. */
export const ENGINE_VERSION = '0.1.0'

export function majorOf(version: string): string {
  return version.split('.')[0] ?? version
}

/**
 * Builds the initial state from `MATCH_CREATED`.
 *
 * Everything §11's non-negotiables call for is taken from the event and never dereferenced
 * again: the seed, the resolved ruleset, the roster, the resolved program, and the engine
 * version. A match that has begun cannot be affected by editing a mode file or retiring a
 * character, because it is not reading either one.
 */
export function createMatch(event: EventEnvelope): MatchState {
  const p = event.payload as PayloadOf<'MATCH_CREATED'>

  const rounds: RoundState[] = []
  for (let i = 0; i < ROUND_COUNT; i++) {
    if (!isRoundIdx(i)) throw new RangeError(`round index ${i} out of range`)
    rounds.push({
      index: i,
      privilegeHolder: null,
      turnOrderHolder: null,
      roll: null,
      ban: null,
      selection: { A: publicSlice(null), B: publicSlice(null) },
      playOrder: null,
      result: null,
    })
  }

  return {
    status: 'LOBBY',
    ruleset: p.ruleset,
    roster: p.roster,
    mode: p.mode,
    seed: p.seed,
    engineVersion: p.engineVersion,
    seatsFilled: { A: false, B: false },
    seats: {
      A: { slots: publicSlice([]), metaBanPlaced: publicSlice(null), score: 0 },
      B: { slots: publicSlice([]), metaBanPlaced: publicSlice(null), score: 0 },
    },
    metaBannedAgainst: { A: [], B: [] },
    rounds,
    cursor: 0,
    outcome: null,
    log: [event],
  }
}
