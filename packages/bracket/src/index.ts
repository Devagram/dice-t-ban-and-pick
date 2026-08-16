/**
 * `@banpick/bracket` — D37's tournament bracket, as a pure function.
 *
 * Build a structure, fold a result log over it, read the answers. No IO, no clock, no ambient
 * randomness, and no knowledge that a match, a mode, or a Durable Object exists.
 */

export * from './types.js'
export {
  buildBracket,
  GRAND_FINAL,
  GRAND_FINAL_RESET,
  losersId,
  MAX_ENTRANTS,
  MIN_ENTRANTS,
  winnersId,
} from './build.js'
export { bracketSize, roundsFor, seedOrder } from './seeding.js'
export {
  champion,
  isComplete,
  isEliminated,
  lossesOf,
  occupantOf,
  readySlots,
  statusOf,
  views,
  viewOf,
  type Occupant,
} from './derive.js'
export {
  advance,
  applyResult,
  applyResults,
  BracketError,
  dispute,
  downstreamOf,
  drawn,
  rederive,
  voidSlot,
} from './advance.js'
