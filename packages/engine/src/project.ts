import {
  otherSeat,
  regulationRounds,
  SEATS,
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
import { resultsFrozen } from './undoWindow.js'
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
    if (visible(src.slots)) {
      view.slots = src.slots.value.map((slot) => maskBanned(maskConsumed(slot, s), s))
    }
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

  /**
   * D36 — the same leak as `maskConsumed`, in the other direction.
   *
   * A round ban writes `bannedInRound` onto a slot on the *opponent's* board, and `slots` is
   * public once the draft reveals. For a sequential ban that is correct: the ban is placed in the
   * open and everyone may see it. For a simultaneous hidden one it hands the victim the answer
   * before the reveal — they would watch a character grey out and know what to plan around while
   * still choosing their own ban.
   *
   * So the flag inherits the visibility of the ban that set it. Note the asymmetry with
   * `maskConsumed`: there the slot's owner may always see their own board, because the fact being
   * hidden is *theirs*. Here the fact belongs to the **other** seat — the banner — so the owner of
   * the slot is precisely the person it must be hidden from, and `ban[otherSeat(owner)]` is the
   * slice whose visibility governs.
   */
  const maskBanned = (slot: Slot, owner: Seat): Slot => {
    if (slot.bannedInRound === null) return slot
    const round = state.rounds.find((r) => r.index === slot.bannedInRound)
    const placedBy = round?.ban[otherSeat(owner)]
    return placedBy && visible(placedBy) ? slot : { ...slot, bannedInRound: null }
  }

  const roundView = (index: number): RoundView => {
    const src = state.rounds[index]!
    const selection: Partial<Record<Seat, SlotIdx | null>> = {}
    const ban: Partial<Record<Seat, SlotIdx | null>> = {}
    for (const s of ['A', 'B'] as const) {
      if (visible(src.selection[s])) selection[s] = src.selection[s].value
      if (visible(src.ban[s])) ban[s] = src.ban[s].value
    }
    return {
      index: src.index,
      privilegeHolder: src.privilegeHolder,
      turnOrderHolder: src.turnOrderHolder,
      roll: src.roll,
      ban,
      // Like `selectionCommitted`: *that* a seat has banned is public even while *what* they
      // banned is sealed, because otherwise the wait for the other seat is unexplainable.
      banCommitted: {
        A: src.ban.A.value !== null,
        B: src.ban.B.value !== null,
      },
      selection,
      selectionCommitted: {
        A: src.selection.A.value !== null,
        B: src.selection.B.value !== null,
      },
      playOrder: src.playOrder,
      result: src.result,
      overtime: src.index >= regulationRounds(state.mode.match),
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
    /*
     * D30 — the overtime round is dropped from the view unless it can still matter.
     *
     * It exists in every match's state so the terminal rule has something to reason about, but a
     * round strip showing an "OT" that can never be reached is a lie told to a player at
     * `draftCount: 3`, where regulation spends the last character. Decided here rather than in
     * the client for the usual reason (§11): whether a round is reachable is a rule.
     */
    rounds: state.rounds
      .map((_, i) => roundView(i))
      .filter((r) => !r.overtime || r.result !== null || overtimeStillPossible(state)),
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
    // D39 — public, and the same for both seats: it is a fact about the match, not about a player.
    frozen: frozenNote(state),
    outcome: state.outcome,
    seq: state.log.length,
  }
}

/**
 * D30 — could the tiebreaker still be reached from here?
 *
 * Not "is it owed now" but "is it possible at all", which is the question a round strip is
 * asking: a seat that will have spent every character by the end of regulation can never play
 * it, and at `draftCount: 3` that is both of them from the opening frame.
 *
 * Deliberately generous. It answers yes for a match that is about to be decided 2-0 in
 * regulation, because "you might have gone to overtime" was true right up until it wasn't, and
 * a pip that vanishes the instant the outcome firms up is more startling than one that greys.
 *
 * Does not re-check `mode.overtime.enabled`, deliberately. `createMatch` only builds the fourth
 * round state when the mode declares one, so a round that reports `overtime: true` is already
 * proof the mode enabled it — and the caller only asks about those. A second check here would be
 * a branch no state can reach, which is worse than no check: it reads as a case someone handled.
 */
/** D39 — the reason, or nothing at all. Shaped so the client renders it without a second lookup. */
function frozenNote(state: MatchState): { reason: string } | null {
  const frozen = resultsFrozen(state)
  return frozen.frozen ? { reason: frozen.reason } : null
}

function overtimeStillPossible(state: MatchState): boolean {
  // D36 — "drafted more than regulation will spend", which is the actual question. Against a
  // literal 3 it was the same sum only because every mode was a Bo3.
  const regulation = regulationRounds(state.mode.match)
  return SEATS.every((seat) => state.seats[seat].slots.value.length > regulation)
}
