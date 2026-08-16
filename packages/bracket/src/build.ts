import { assignSeeds, bracketSize, roundsFor, seedOrder } from './seeding.js'
import type { BracketFormat, BracketState, BuildOptions, Entrant, Ref, Slot } from './types.js'

/** D42 — stated and enforced. See the scale note on `TournamentDO`, and `RegistryDO`'s before it. */
export const MAX_ENTRANTS = 32
export const MIN_ENTRANTS = 2

export const winnersId = (round: number, match: number): string => `W${round}M${match}`
export const losersId = (round: number, match: number): string => `L${round}M${match}`
export const GRAND_FINAL = 'GF'
export const GRAND_FINAL_RESET = 'GF2'

/**
 * Builds the whole structure up front, results-independent.
 *
 * **Every slot that can ever exist exists now**, including D40's reset match and every slot that
 * a bye will resolve without anyone playing. Nothing is materialised mid-tournament — the same
 * argument `resolveMode` makes for expanding D30's overtime round at resolution time rather than
 * conjuring it at run time: a structure that grows during play puts control flow back into the
 * thing that was supposed to be a fold, and breaks replay.
 */
export function buildBracket(
  format: BracketFormat,
  entrants: readonly Entrant[],
  opts: BuildOptions = {},
): BracketState {
  if (entrants.length < MIN_ENTRANTS) {
    throw new RangeError(
      `a bracket needs at least ${MIN_ENTRANTS} entrants, got ${entrants.length}`,
    )
  }
  if (entrants.length > MAX_ENTRANTS) {
    throw new RangeError(
      `a bracket holds at most ${MAX_ENTRANTS} entrants (D42), got ${entrants.length}. ` +
        'One Durable Object serialises every write; the cap is the honest limit, not a guess.',
    )
  }
  const ids = new Set(entrants.map((e) => e.entrantId))
  if (ids.size !== entrants.length) {
    throw new RangeError('every entrant needs a distinct entrantId')
  }

  const seedingSeed = opts.seedingSeed ?? 'unseeded'
  const seeded = assignSeeds(entrants, opts.seeding ?? 'AS_ENTERED', seedingSeed)
  const size = bracketSize(seeded.length)
  const rounds = roundsFor(size)

  const grandFinalReset = format === 'DOUBLE_ELIMINATION' && (opts.grandFinalReset ?? true)

  const slots =
    format === 'SINGLE_ELIMINATION'
      ? singleElimination(seeded, size, rounds)
      : doubleElimination(seeded, size, rounds, grandFinalReset)

  return {
    format,
    entrants: seeded,
    slots,
    grandFinalReset,
    finalSlotId: format === 'SINGLE_ELIMINATION' ? winnersId(rounds, 1) : GRAND_FINAL,
    seedingSeed,
    results: [],
  }
}

// --- Winners bracket (and the whole of single elimination) --------------------------------------

/**
 * Round one, seeded. Positions beyond the entrant count become byes, which lands them on the top
 * seeds by construction: `seedOrder` pairs 1 with the weakest position, and the weakest positions
 * are exactly the ones nobody filled.
 */
function firstRound(seeded: readonly Entrant[], size: number): Ref[] {
  return seedOrder(size).map((seed): Ref => {
    const entrant = seeded[seed - 1]
    return entrant ? { from: 'ENTRANT', entrantId: entrant.entrantId } : { from: 'BYE' }
  })
}

function winnersSlots(seeded: readonly Entrant[], size: number, rounds: number): Slot[] {
  const positions = firstRound(seeded, size)
  const slots: Slot[] = []

  for (let round = 1; round <= rounds; round++) {
    const matches = size / 2 ** round
    for (let match = 1; match <= matches; match++) {
      const entrants: [Ref, Ref] =
        round === 1
          ? [positions[match * 2 - 2]!, positions[match * 2 - 1]!]
          : [
              { from: 'WINNER_OF', slotId: winnersId(round - 1, match * 2 - 1) },
              { from: 'WINNER_OF', slotId: winnersId(round - 1, match * 2) },
            ]

      slots.push({
        id: winnersId(round, match),
        side: 'WINNERS',
        round,
        match,
        entrants,
        winnerTo: round < rounds ? winnersId(round + 1, Math.ceil(match / 2)) : null,
        loserTo: null, // single elimination; `doubleElimination` fills these in
      })
    }
  }

  return slots
}

function singleElimination(seeded: readonly Entrant[], size: number, rounds: number): Slot[] {
  return winnersSlots(seeded, size, rounds)
}

// --- Losers bracket -----------------------------------------------------------------------------

/**
 * **The part that is genuinely hard, written out rather than derived cleverly.**
 *
 * For a bracket of `2^k`, the losers bracket has `2(k-1)` rounds, alternating:
 *
 * - **Minor** rounds (odd: L1, L3, …) pair losers-bracket survivors against each other. L1 is the
 *   exception in source only — it pairs losers of winners round 1, which is the same thing viewed
 *   from one round earlier.
 * - **Major** rounds (even: L2, L4, …) pair the previous minor round's winners against fresh
 *   losers dropping in from winners round `i+1`.
 *
 * Both `L(2i-1)` and `L(2i)` hold `2^(k-i-1)` matches, which is what makes the halves line up
 * without a remainder at every size.
 *
 *     k=2 (4):  L1×1  L2×1                        W1→L1  W2→L2
 *     k=3 (8):  L1×2  L2×2  L3×1  L4×1            W1→L1  W2→L2  W3→L4
 *     k=4 (16): L1×4  L2×4  L3×2  L4×2  L5×1 L6×1 W1→L1  W2→L2  W3→L4  W4→L6
 *
 * **The anti-rematch rule.** Dropping winners-bracket losers straight into a major round
 * reproduces a pairing that just happened: `L(2i-1)M m` holds survivors from the same half of the
 * bracket that `W(i+1)M m` was fought in, so its winner can meet the person who just knocked them
 * out. Reversing the incoming order provably removes that for the first major round, which is the
 * case it can actually occur in at small sizes.
 *
 * **Honest limit:** this is one convention, not the only one, and at 16 and 32 a rematch remains
 * *possible* several rounds deep for some result sequences. Eliminating those entirely requires a
 * published per-size placement table, and inventing one that looks plausible would be worse than
 * a documented simple rule. What is guaranteed and tested: nobody is eliminated without two
 * losses, exactly one champion is reachable, and the first major round never rematches.
 */
function losersSlots(rounds: number): Slot[] {
  const slots: Slot[] = []
  const losersRounds = 2 * (rounds - 1)

  for (let round = 1; round <= losersRounds; round++) {
    const i = Math.ceil(round / 2)
    const matches = 2 ** (rounds - i - 1)
    const major = round % 2 === 0

    for (let match = 1; match <= matches; match++) {
      const entrants: [Ref, Ref] = major
        ? [
            { from: 'WINNER_OF', slotId: losersId(round - 1, match) },
            // Reversed — see the note above.
            { from: 'LOSER_OF', slotId: winnersId(i + 1, matches + 1 - match) },
          ]
        : round === 1
          ? [
              { from: 'LOSER_OF', slotId: winnersId(1, match * 2 - 1) },
              { from: 'LOSER_OF', slotId: winnersId(1, match * 2) },
            ]
          : [
              { from: 'WINNER_OF', slotId: losersId(round - 1, match * 2 - 1) },
              { from: 'WINNER_OF', slotId: losersId(round - 1, match * 2) },
            ]

      slots.push({
        id: losersId(round, match),
        side: 'LOSERS',
        round,
        match,
        entrants,
        winnerTo: round < losersRounds ? losersId(round + 1, nextMatch(round, match)) : GRAND_FINAL,
        // Every losers slot is an elimination point. That is the whole shape of the thing.
        loserTo: null,
      })
    }
  }

  return slots
}

/** A minor round halves the field; a major round keeps its width. */
function nextMatch(round: number, match: number): number {
  return round % 2 === 0 ? Math.ceil(match / 2) : match
}

function doubleElimination(
  seeded: readonly Entrant[],
  size: number,
  rounds: number,
  grandFinalReset: boolean,
): Slot[] {
  const winners = winnersSlots(seeded, size, rounds)
  const losers = losersSlots(rounds)
  const losersRounds = losers.length === 0 ? 0 : 2 * (rounds - 1)

  const winnersFinal = winnersId(rounds, 1)

  /*
   * Route each winners loser into the losers round that receives that round's drop-ins — and the
   * winners **final** forward to the grand final.
   *
   * That second half is easy to forget, and its absence does not look like a bug: `winnersSlots`
   * correctly leaves the last round's `winnerTo` null because in single elimination that slot ends
   * the tournament. In double elimination it does not, and a winners final still claiming to be
   * terminal makes it a second candidate for "the slot that decides this", which is exactly what
   * the N=4 invariant test caught — a champion crowned with the losers bracket still playing.
   */
  const routed = winners.map((slot): Slot => {
    const winnerTo = slot.id === winnersFinal ? GRAND_FINAL : slot.winnerTo
    if (losersRounds === 0) {
      // Two entrants: there is no losers bracket, and the one loser goes straight to the final.
      return { ...slot, winnerTo, loserTo: GRAND_FINAL }
    }
    const target = slot.round === 1 ? 1 : 2 * (slot.round - 1)
    return { ...slot, winnerTo, loserTo: losersId(target, targetMatch(slot, target, rounds)) }
  })
  const losersFinal = losersRounds === 0 ? null : losersId(losersRounds, 1)

  const grandFinal: Slot = {
    id: GRAND_FINAL,
    side: 'GRAND_FINAL',
    round: 1,
    match: 1,
    entrants: [
      { from: 'WINNER_OF', slotId: winnersFinal },
      losersFinal
        ? { from: 'WINNER_OF', slotId: losersFinal }
        : { from: 'LOSER_OF', slotId: winnersFinal },
    ],
    winnerTo: null,
    loserTo: null,
  }

  if (!grandFinalReset) return [...routed, ...losers, grandFinal]

  /*
   * D40 — the reset.
   *
   * `GF2` is unconditionally in the structure and conditionally *reachable*: it is entered only
   * when the losers-bracket entrant wins `GF`, which `deriveSlot` decides by checking who came
   * from where. It is terminal by construction — `winnerTo: null`, and nothing routes out of it —
   * which is what stops a reset that can itself reset, the one way this format could fail to
   * terminate.
   */
  const reset: Slot = {
    id: GRAND_FINAL_RESET,
    side: 'GRAND_FINAL',
    round: 2,
    match: 1,
    entrants: [
      { from: 'WINNER_OF', slotId: GRAND_FINAL },
      { from: 'LOSER_OF', slotId: GRAND_FINAL },
    ],
    winnerTo: null,
    loserTo: null,
  }

  return [...routed, ...losers, { ...grandFinal, winnerTo: null }, reset]
}

/**
 * Which match of the receiving losers round a given winners loser drops into.
 *
 * Round 1 packs two losers per match in order. Later rounds land in a major round, which is
 * reversed against the survivors already sitting there — the anti-rematch rule, applied from the
 * sending side so both halves of the pairing agree on it.
 */
function targetMatch(slot: Slot, target: number, rounds: number): number {
  if (slot.round === 1) return Math.ceil(slot.match / 2)
  const i = Math.ceil(target / 2)
  const matches = 2 ** (rounds - i - 1)
  return matches + 1 - slot.match
}
