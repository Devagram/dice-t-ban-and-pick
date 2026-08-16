import {
  advance,
  buildBracket,
  isComplete,
  readySlots,
  statusOf,
  viewOf,
  type BracketFormat,
  type BracketState,
  type BuildOptions,
  type Entrant,
  type EntrantId,
  type SlotId,
} from '@banpick/bracket'

/** `n` entrants named `e1..en`, seeded in the order given. */
export function entrants(n: number): Entrant[] {
  return Array.from({ length: n }, (_, i) => ({
    entrantId: `e${i + 1}`,
    playerId: `p${i + 1}`,
    displayName: `Entrant ${i + 1}`,
    seed: i + 1,
  }))
}

export function build(
  n: number,
  format: BracketFormat = 'DOUBLE_ELIMINATION',
  opts: BuildOptions = {},
): BracketState {
  return buildBracket(format, entrants(n), opts)
}

export const idsOf = (bracket: BracketState): SlotId[] => bracket.slots.map((s) => s.id)

export function slot(bracket: BracketState, id: SlotId) {
  const found = bracket.slots.find((s) => s.id === id)
  if (!found) throw new Error(`no slot '${id}'`)
  return found
}

export const statusIn = (bracket: BracketState, id: SlotId): string =>
  statusOf(bracket, slot(bracket, id))

/** The two resolved entrants of a slot, as ids. `null` where the side is a bye or unknown. */
export function sidesOf(bracket: BracketState, id: SlotId): [EntrantId | null, EntrantId | null] {
  return viewOf(bracket, slot(bracket, id)).entrants
}

/**
 * Plays every ready slot until the bracket completes, choosing winners with `pick`.
 *
 * Throws rather than looping forever if it stalls, and names the state it stuck in: a bracket
 * that cannot finish is this layer's version of the 1.5–1.5 deadlock G14 refuses, and a hanging
 * test says far less about it than a failing one.
 */
export function playOut(
  bracket: BracketState,
  pick: (a: EntrantId, b: EntrantId, slotId: SlotId) => EntrantId,
): BracketState {
  let current = bracket
  for (let guard = 0; guard < 512; guard++) {
    if (isComplete(current)) return current
    const ready = readySlots(current)
    if (ready.length === 0) {
      throw new Error(
        `stalled with no champion: ${current.slots
          .map((s) => `${s.id}=${statusOf(current, s)}`)
          .join(' ')}`,
      )
    }
    const next = ready[0]!
    const [a, b] = viewOf(current, next).entrants
    if (a === null || b === null) throw new Error(`READY slot '${next.id}' has an unknown side`)
    current = advance(current, next.id, pick(a, b, next.id))
  }
  throw new Error('playOut: did not terminate within 512 advances')
}

/** Always advances the numerically lower entrant — the seed favourite. */
export const favourite = (a: EntrantId, b: EntrantId): EntrantId =>
  Number(a.slice(1)) <= Number(b.slice(1)) ? a : b

/** Always advances the underdog. The mirror case, which is where upsets stress the routing. */
export const underdog = (a: EntrantId, b: EntrantId): EntrantId =>
  Number(a.slice(1)) > Number(b.slice(1)) ? a : b
