import {
  otherSeat,
  type MatchState,
  type PlayerView,
  type RoundView,
  type Seat,
  type SeatView,
  type Slice,
  type Slot,
  type SlotIdx,
} from '@banpick/types'

import { currentModule } from './context.js'
import { legalActions } from './legalActions.js'
import { moduleFor } from './modules/index.js'

/**
 * Spec §7 — **the security boundary.**
 *
 *     project(state, seat) =>
 *       mapSlices(state, s =>
 *         s.owner === null || s.owner === seat || (s.revealedBy && state.log.has(s.revealedBy))
 *           ? s.value
 *           : REDACTED)
 *
 * With one hard rule on top: *"The client must never receive a redacted value with a flag; it
 * must receive nothing."* So a hidden field is **absent from the object**, not null and not
 * flagged — which is why the required §7 test asserts on the serialized string. An object test
 * passes while a `toJSON` leaks.
 */
export function project(state: MatchState, seat: Seat): PlayerView {
  const revealed = new Set(state.log.map((e) => e.tag))

  // D29 — who sat down, read off the log. Public on both seats: the name is shown to the other
  // player by design, and the id is what a head-to-head record is looked up by.
  const players: Partial<Record<Seat, { id: string; name: string }>> = {}
  for (const event of state.log) {
    if (event.payload.type === 'SEAT_FILLED' && event.payload.player) {
      players[event.payload.seat] = event.payload.player
    }
  }

  /** The §7 predicate itself, in one place so there is one place to get it wrong. */
  const visible = (slice: Slice<unknown>): boolean =>
    slice.owner === null ||
    slice.owner === seat ||
    (slice.revealedBy !== null && revealed.has(slice.revealedBy))

  const seatView = (s: Seat): SeatView => {
    const src = state.seats[s]
    const view: SeatView = {
      seat: s,
      score: src.score,
      hasCommitted: src.slots.value.length > 0,
      slotCount: src.slots.value.length,
    }
    // Assigned conditionally rather than set to undefined: `exactOptionalPropertyTypes` makes
    // the difference real, and the difference is the whole guarantee.
    if (visible(src.slots)) view.slots = src.slots.value.map((slot) => maskConsumed(slot, s))
    if (visible(src.metaBanPlaced)) view.metaBanPlaced = src.metaBanPlaced.value
    const player = players[s]
    if (player) view.player = player
    // D28 — your own denial, and only your own. Theirs would say what they banned last set.
    if (s === seat && state.deniedMetaBans[s].length > 0) {
      view.deniedMetaBans = [...state.deniedMetaBans[s]]
    }
    return view
  }

  /**
   * §7 — a slot must not report itself spent before the selection that spent it is visible.
   *
   * Selecting consumes the slot immediately (D6 consumes it even on a tie), and `slots` is public
   * once the draft reveals. In round 2 that combination leaked the whole point of the round: the
   * select is `SIMULTANEOUS_HIDDEN`, so `selection` is correctly sealed — but the opponent could
   * see *which* of your characters had just become consumed, which is the same fact by another
   * route. Whoever picked second could simply read the board.
   *
   * So `consumed` is derived from the selection that caused it, and inherits that selection's
   * visibility. The flag was always in the projection; it only became *legible* when the board
   * started using position and colour to say "spent".
   */
  const maskConsumed = (slot: Slot, owner: Seat): Slot => {
    if (!slot.consumed || owner === seat) return slot
    const consumedVisibly = state.rounds.some(
      (round) => round.selection[owner].value === slot.index && visible(round.selection[owner]),
    )
    return consumedVisibly ? slot : { ...slot, consumed: false }
  }

  const roundView = (index: number): RoundView => {
    const src = state.rounds[index]!
    const selection: Partial<Record<Seat, SlotIdx | null>> = {}
    for (const s of ['A', 'B'] as const) {
      if (visible(src.selection[s])) selection[s] = src.selection[s].value
    }
    return {
      index: src.index,
      privilegeHolder: src.privilegeHolder,
      turnOrderHolder: src.turnOrderHolder,
      roll: src.roll,
      ban: src.ban,
      selection,
      selectionCommitted: {
        A: src.selection.A.value !== null,
        B: src.selection.B.value !== null,
      },
      playOrder: src.playOrder,
      result: src.result,
    }
  }

  const mod = currentModule(state)

  return {
    status: state.status,
    seat,
    engineVersion: state.engineVersion,
    ruleset: state.ruleset,
    mode: {
      modeId: state.mode.modeId,
      label: state.mode.label,
      parameters: state.mode.parameters,
    },
    roster: state.roster.characters,
    you: seatView(seat),
    opponent: seatView(otherSeat(seat)),
    rounds: state.rounds.map((_, i) => roundView(i)),
    phase:
      mod && state.status === 'IN_PROGRESS'
        ? {
            moduleId: mod.id,
            type: mod.type,
            roundIndex: mod.roundIndex,
            awaiting: moduleFor(mod).awaiting({ state, mod }),
          }
        : null,
    legalActions: legalActions(state, seat),
    outcome: state.outcome,
    seq: state.log.length,
  }
}
