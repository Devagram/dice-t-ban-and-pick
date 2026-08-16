import { occupantOf, statusOf } from './derive.js'
import type { BracketState, EntrantId, ResultEntry, SlotId } from './types.js'

/**
 * **Appending to the result log, which is the only way a bracket ever changes.**
 *
 * Every function here returns a new state and mutates nothing, so
 * `results.reduce(applyResult, buildBracket(...))` equals the incrementally-advanced bracket.
 * D39's correction path rests entirely on that equality, and Phase 1's test gate asserts it
 * directly rather than trusting it.
 */

export class BracketError extends Error {
  readonly code: 'UNKNOWN_SLOT' | 'SLOT_NOT_READY' | 'NOT_IN_SLOT'

  constructor(code: BracketError['code'], message: string) {
    super(message)
    this.name = 'BracketError'
    this.code = code
  }
}

function append(bracket: BracketState, entry: ResultEntry): BracketState {
  return { ...bracket, results: [...bracket.results, entry] }
}

/**
 * Records a winner.
 *
 * Refuses a slot that is not `READY` **or** already decided-and-being-corrected — the latter is
 * allowed on purpose, because D39's organizer correction is "report a different winner for a slot
 * that already has one", and forbidding it here would push the correction path into rewriting the
 * log instead of appending to it.
 */
export function advance(bracket: BracketState, slotId: SlotId, winner: EntrantId): BracketState {
  const slot = bracket.slots.find((s) => s.id === slotId)
  if (!slot) throw new BracketError('UNKNOWN_SLOT', `no slot '${slotId}' in this bracket`)

  const status = statusOf(bracket, slot)
  if (status === 'PENDING' || status === 'BYE') {
    throw new BracketError(
      'SLOT_NOT_READY',
      `slot '${slotId}' is ${status}: ` +
        (status === 'BYE'
          ? 'a walkover is decided by the structure, not by a reported result'
          : 'at least one side is still unknown'),
    )
  }

  const sides = slot.entrants.map((ref) => occupantOf(bracket, ref))
  if (!sides.some((o) => o.kind === 'ENTRANT' && o.entrantId === winner)) {
    throw new BracketError(
      'NOT_IN_SLOT',
      `'${winner}' is not in slot '${slotId}', so cannot have won it`,
    )
  }

  return append(bracket, { slotId, type: 'WIN', winner })
}

/**
 * D38 — the two seats disagreed.
 *
 * Resolves nobody and routes nobody, which is what makes a dispute halt exactly one branch: every
 * slot downstream of it stays `PENDING` while the rest of the bracket carries on. There is no
 * adjudication rule here on purpose — two people who disagree about who won is not a case an
 * algorithm should settle, and Phase 7 gives it to the organizer instead.
 */
export function dispute(bracket: BracketState, slotId: SlotId): BracketState {
  if (!bracket.slots.some((s) => s.id === slotId)) {
    throw new BracketError('UNKNOWN_SLOT', `no slot '${slotId}' in this bracket`)
  }
  return append(bracket, { slotId, type: 'DISPUTE' })
}

/** D39 — the organizer voided it. Like a dispute for routing; distinguished so the UI can say which. */
export function voidSlot(bracket: BracketState, slotId: SlotId): BracketState {
  if (!bracket.slots.some((s) => s.id === slotId)) {
    throw new BracketError('UNKNOWN_SLOT', `no slot '${slotId}' in this bracket`)
  }
  return append(bracket, { slotId, type: 'VOID' })
}

/**
 * The match was played and nobody won.
 *
 * D21 makes a level match a legal terminal state and D36's Bo1 allows a tied single round, so this
 * is reachable in any tournament using either — it is not a defensive case. Like a dispute it
 * routes nobody and waits for a person: replay, coin toss, or walkover are all defensible and none
 * of them is the app's call.
 */
export function drawn(bracket: BracketState, slotId: SlotId): BracketState {
  if (!bracket.slots.some((s) => s.id === slotId)) {
    throw new BracketError('UNKNOWN_SLOT', `no slot '${slotId}' in this bracket`)
  }
  return append(bracket, { slotId, type: 'DRAWN' })
}

/** The fold. Rebuilding from a corrected log is this, and nothing else. */
export function applyResult(bracket: BracketState, entry: ResultEntry): BracketState {
  return append(bracket, entry)
}

export function applyResults(bracket: BracketState, entries: readonly ResultEntry[]): BracketState {
  return entries.reduce(applyResult, bracket)
}

/**
 * D39 — re-derive from a corrected log.
 *
 * Takes the structure as built and replays a result list over it, which is the operation an
 * organizer correction performs. Deliberately not a patch: correcting the semi-final by editing
 * the current state would leave whatever the final already computed sitting there, and the whole
 * reason results are a log is so that cannot happen.
 */
export function rederive(bracket: BracketState, results: readonly ResultEntry[]): BracketState {
  return applyResults({ ...bracket, results: [] }, results)
}

/**
 * Which already-recorded slots stop making sense if `slotId`'s result changes.
 *
 * Everything reachable downstream, whether or not it has been played. The organizer console shows
 * this **before** applying a correction (plan Phase 7): matches not yet played are simply
 * invalidated, and matches already played are a judgement about the evening that D39 refuses to
 * make on the organizer's behalf.
 */
export function downstreamOf(bracket: BracketState, slotId: SlotId): SlotId[] {
  const out: SlotId[] = []
  const seen = new Set<SlotId>([slotId])
  const queue: SlotId[] = [slotId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const slot of bracket.slots) {
      const feeds = slot.entrants.some(
        (ref) => (ref.from === 'WINNER_OF' || ref.from === 'LOSER_OF') && ref.slotId === current,
      )
      if (!feeds || seen.has(slot.id)) continue
      seen.add(slot.id)
      out.push(slot.id)
      queue.push(slot.id)
    }
  }

  return out
}
