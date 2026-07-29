import type { MatchState, RoundIdx } from '@banpick/types'

/**
 * D15 — when `UNDO_LAST_RESULT` is available.
 *
 * The spec says "open until the next round's roll". Taken literally that window is **zero
 * width**: the roll is a SYSTEM event, and the system fires it the instant the previous round's
 * report lands, so the undo would never be reachable. The same is true of round 1, which has no
 * roll at all — D10 replaced it with an ASSIGN that fires just as eagerly.
 *
 * So the window closes on the next round's first **player-authored** event. A roll and an
 * inversion are bookkeeping; a seat has not committed to anything until it chooses, bans, or
 * selects. That preserves what D15 was actually protecting — undo covers a fat finger, and stops
 * once the next round is genuinely underway.
 *
 * Seeing the next round's roll before undoing is not an exploit. The roll is a pure function of
 * `(seed, seq)`, undoing does not re-roll it, and the thing being corrected is a claim about a
 * dice game played off-app against a counterparty §1 already grants is friendly.
 */
export function roundHasPlayerAction(state: MatchState, index: RoundIdx): boolean {
  return state.log.some(
    (e) =>
      e.actor !== 'SYSTEM' &&
      'roundIndex' in e.payload &&
      e.payload.roundIndex === index &&
      e.payload.type !== 'UNDO_LAST_RESULT',
  )
}

/** The round whose result may still be undone, or `null` if none may. */
export function undoableRound(state: MatchState): RoundIdx | null {
  for (let i = state.rounds.length - 1; i >= 0; i--) {
    const round = state.rounds[i]!
    if (round.result === null) continue
    const next = state.rounds[i + 1]
    if (next && roundHasPlayerAction(state, next.index)) return null
    return round.index
  }
  return null
}
