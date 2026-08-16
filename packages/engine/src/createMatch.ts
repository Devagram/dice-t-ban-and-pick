import {
  regulationRounds,
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
  /*
   * D30 — one extra round state when the mode declares overtime. It may never be played;
   * `isDecided` is what decides that, and it needs the round to exist to reason about.
   *
   * D36 — and the regulation count comes from the mode rather than from a constant. Allocating
   * three for a one-round mode was not merely wasteful: the two extra rounds are indistinguishable
   * from rounds that were played and tied, so they reached the stored record and the history page
   * as real-looking blanks.
   */
  const roundCount = regulationRounds(p.mode.match) + (p.mode.overtime.enabled ? 1 : 0)
  for (let i = 0; i < roundCount; i++) {
    if (!isRoundIdx(i)) throw new RangeError(`round index ${i} out of range`)
    rounds.push({
      index: i,
      privilegeHolder: null,
      turnOrderHolder: null,
      roll: null,
      // D36 — one entry per seat, because a simultaneous ban has two. A mode where only one seat
      // bans simply leaves the other entry null.
      ban: { A: publicSlice(null), B: publicSlice(null) },
      selection: { A: publicSlice(null), B: publicSlice(null) },
      playOrder: null,
      // D38 — one claim per seat. Under D15's one-sided reporting only one is ever filled.
      reports: { A: null, B: null },
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
    // D28 — filled by PAIRING_RESOLVED once both seats are known, if the rule is on.
    deniedMetaBans: { A: [], B: [] },
    rounds,
    cursor: 0,
    outcome: null,
    log: [event],
  }
}
