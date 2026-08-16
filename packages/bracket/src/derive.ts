import { GRAND_FINAL, GRAND_FINAL_RESET } from './build.js'
import type { BracketState, EntrantId, Ref, Slot, SlotId, SlotStatus, SlotView } from './types.js'

/**
 * Everything a bracket *is*, computed from its structure plus its result log.
 *
 * Nothing here is stored. That is the same argument `RegistryDO` makes about totals — "derived,
 * never incremented" — and it earns more here than it does there, because D39's correction path
 * is literally "append a corrected result and read again". A cached bracket would be a second
 * truth, and the stale one is always the one nobody is looking at.
 */

/** A resolved side of a slot: somebody, nobody, or not-yet-known. */
export type Occupant =
  | { kind: 'ENTRANT'; entrantId: EntrantId }
  /** Structurally empty. A walkover, not a competitor. */
  | { kind: 'BYE' }
  | { kind: 'UNKNOWN' }

const UNKNOWN: Occupant = { kind: 'UNKNOWN' }
const BYE: Occupant = { kind: 'BYE' }

/** The live entry for a slot. Last write wins, which is what makes a correction an append (D39). */
function latestResult(bracket: BracketState, slotId: SlotId) {
  for (let i = bracket.results.length - 1; i >= 0; i--) {
    const entry = bracket.results[i]!
    if (entry.slotId === slotId) return entry
  }
  return null
}

/**
 * Throws rather than returning null, deliberately.
 *
 * A `Ref` naming a slot the bracket does not contain is a bug in `buildBracket`, not a state a
 * tournament can be in — so tolerating it would add a branch no result sequence can reach, and
 * `project.ts` already says why that is worse than no check: "it reads as a case someone handled."
 * The public entry points validate slot ids against real input before getting here.
 */
function slotById(bracket: BracketState, slotId: SlotId): Slot {
  const found = bracket.slots.find((s) => s.id === slotId)
  if (!found) throw new Error(`bracket is malformed: no slot '${slotId}' for a ref that names it`)
  return found
}

/**
 * Who occupies a `Ref`.
 *
 * Recursive rather than iterative because a bracket is a tree and the recursion depth is
 * `log2(32) * 2 + 2`, which is nine. A memo would be an optimisation of something that is already
 * free at this size, and it would need invalidating.
 */
export function occupantOf(bracket: BracketState, ref: Ref): Occupant {
  switch (ref.from) {
    case 'ENTRANT':
      return { kind: 'ENTRANT', entrantId: ref.entrantId }
    case 'BYE':
      return BYE
    case 'WINNER_OF':
      return winnerOccupant(bracket, slotById(bracket, ref.slotId))
    case 'LOSER_OF':
      return loserOccupant(bracket, slotById(bracket, ref.slotId))
  }
}

/**
 * The winner of a slot, if it has one.
 *
 * A bye is decided without anyone playing, and that has to happen *here* rather than by writing a
 * result: a walkover is not a game anybody played, and putting one in the result log would make it
 * indistinguishable from one somebody did.
 */
export function winnerOccupant(bracket: BracketState, slot: Slot): Occupant {
  const [a, b] = sides(bracket, slot)

  /*
   * Handled symmetrically rather than side-by-side, and that is not only tidiness.
   *
   * The straight version tested `a` for a bye and then `b`, which reads fine and leaves one
   * branch — `b` is a bye while `a` is still unknown — that no valid bracket can reach: seeding
   * puts the smaller seed of every pair first, so a first-round bye is always on side `b` with a
   * real entrant opposite, and a dropped-in bye is always on side `a`. A branch no state reaches
   * is worse than no branch, because it reads as a case somebody handled.
   */
  if (a.kind === 'BYE' || b.kind === 'BYE') {
    const other = a.kind === 'BYE' ? b : a
    if (other.kind === 'BYE') return BYE
    return other.kind === 'ENTRANT' ? other : UNKNOWN
  }
  if (a.kind === 'UNKNOWN' || b.kind === 'UNKNOWN') return UNKNOWN

  const result = latestResult(bracket, slot.id)
  // DISPUTE, VOID and DRAWN all resolve nobody. The difference between them is what the UI says
  // and what the organizer is being asked to do; `statusOf` is where that lives. Routing has to
  // treat them identically, or a disputed — or drawn — branch would advance somebody.
  if (!result || result.type !== 'WIN') return UNKNOWN
  return { kind: 'ENTRANT', entrantId: result.winner }
}

/**
 * The loser of a slot — the side that is not the winner.
 *
 * A walkover has **no** loser: nobody was knocked into the losers bracket, so downstream that
 * ref resolves to a bye and the other side walks over in turn. Getting this wrong is how a
 * phantom entrant appears three rounds later with no way to trace where they came from.
 */
export function loserOccupant(bracket: BracketState, slot: Slot): Occupant {
  const [a, b] = sides(bracket, slot)
  if (a.kind === 'BYE' || b.kind === 'BYE') return BYE
  if (a.kind === 'UNKNOWN' || b.kind === 'UNKNOWN') return UNKNOWN

  const winner = winnerOccupant(bracket, slot)
  if (winner.kind !== 'ENTRANT') return UNKNOWN
  return winner.entrantId === a.entrantId ? b : a
}

function sides(bracket: BracketState, slot: Slot): [Occupant, Occupant] {
  return [occupantOf(bracket, slot.entrants[0]), occupantOf(bracket, slot.entrants[1])]
}

/**
 * D40 — is the reset match live?
 *
 * Only when the grand final was won by the entrant who arrived from the losers bracket. Decided
 * by comparing the grand final's winner against its *second* ref, which is by construction the
 * losers-bracket side — reading it off the structure rather than tracking a flag, so it stays
 * right after a D39 correction rewrites who won.
 */
function resetIsLive(bracket: BracketState): boolean {
  // `grandFinalReset` is only ever true for a double-elimination bracket, which always has a GF.
  if (!bracket.grandFinalReset) return false
  const gf = slotById(bracket, GRAND_FINAL)
  const winner = winnerOccupant(bracket, gf)
  if (winner.kind !== 'ENTRANT') return false
  const fromLosers = occupantOf(bracket, gf.entrants[1])
  return fromLosers.kind === 'ENTRANT' && fromLosers.entrantId === winner.entrantId
}

export function statusOf(bracket: BracketState, slot: Slot): SlotStatus {
  // The reset is structurally present but unreachable unless the grand final went the one way
  // that calls for it. Reporting it as READY would put a match on the board that must not exist.
  if (slot.id === GRAND_FINAL_RESET && !resetIsLive(bracket)) return 'PENDING'

  const [a, b] = sides(bracket, slot)
  if (a.kind === 'BYE' || b.kind === 'BYE') {
    // Still pending if the other side has not arrived — the walkover is not decided until there
    // is somebody to walk over.
    return a.kind === 'UNKNOWN' || b.kind === 'UNKNOWN' ? 'PENDING' : 'BYE'
  }
  if (a.kind === 'UNKNOWN' || b.kind === 'UNKNOWN') return 'PENDING'

  const result = latestResult(bracket, slot.id)
  if (!result) return 'READY'
  if (result.type === 'DISPUTE') return 'DISPUTED'
  if (result.type === 'VOID') return 'VOIDED'
  if (result.type === 'DRAWN') return 'DRAWN'
  return 'DONE'
}

export function viewOf(bracket: BracketState, slot: Slot): SlotView {
  const [a, b] = sides(bracket, slot)
  const winner = winnerOccupant(bracket, slot)
  const name = (o: Occupant): EntrantId | null => (o.kind === 'ENTRANT' ? o.entrantId : null)
  return {
    slot,
    status: statusOf(bracket, slot),
    entrants: [name(a), name(b)],
    winner: name(winner),
  }
}

export function views(bracket: BracketState): SlotView[] {
  return bracket.slots.map((slot) => viewOf(bracket, slot))
}

/**
 * Every slot with both sides known and no result — what the tournament provisions matches from.
 *
 * A `DISPUTED` or `VOIDED` slot is deliberately **not** ready: a dispute waits on the organizer
 * (D38) and a void waits on a decision to re-run it (D39). Re-provisioning either automatically
 * would be the app overruling a human on exactly the questions it was told not to.
 */
export function readySlots(bracket: BracketState): Slot[] {
  return bracket.slots.filter((slot) => statusOf(bracket, slot) === 'READY')
}

/**
 * The slot that ends the tournament.
 *
 * Named explicitly rather than inferred from `winnerTo === null`, which is how the first version
 * of this went wrong: in double elimination the winners final also had a null `winnerTo`, so it
 * qualified as terminal and crowned a champion while the losers bracket was still playing. The
 * routing bug is fixed, but an inference that *can* pick the wrong slot is worth replacing with a
 * statement that cannot.
 */
function decidingSlot(bracket: BracketState): Slot {
  return slotById(bracket, resetIsLive(bracket) ? GRAND_FINAL_RESET : bracket.finalSlotId)
}

export function champion(bracket: BracketState): EntrantId | null {
  const winner = winnerOccupant(bracket, decidingSlot(bracket))
  return winner.kind === 'ENTRANT' ? winner.entrantId : null
}

export function isComplete(bracket: BracketState): boolean {
  return champion(bracket) !== null
}

/**
 * How many losses an entrant has taken. The invariant double elimination exists to enforce, and
 * therefore the thing worth being able to ask directly rather than inferring from the drawing.
 */
export function lossesOf(bracket: BracketState, entrantId: EntrantId): number {
  let losses = 0
  for (const slot of bracket.slots) {
    const loser = loserOccupant(bracket, slot)
    if (loser.kind === 'ENTRANT' && loser.entrantId === entrantId) losses++
  }
  return losses
}

/** True once an entrant can no longer reach the deciding slot. */
export function isEliminated(bracket: BracketState, entrantId: EntrantId): boolean {
  const cap = bracket.format === 'SINGLE_ELIMINATION' ? 1 : 2
  return lossesOf(bracket, entrantId) >= cap
}
