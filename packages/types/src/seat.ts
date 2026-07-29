/** Spec §5. Exactly two seats, permanently (D19 — no tournament layer above a match). */
export type Seat = 'A' | 'B'

export const SEATS: readonly Seat[] = ['A', 'B'] as const

/**
 * `SYSTEM` authors events no seat decided: the forced `SELECT` of D26, and the
 * round-loop bookkeeping the DO drives. It is an actor, never a seat.
 */
export type Actor = Seat | 'SYSTEM'

export function otherSeat(seat: Seat): Seat {
  return seat === 'A' ? 'B' : 'A'
}
