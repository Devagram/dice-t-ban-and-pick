import {
  activeRoster,
  otherSeat,
  type CharId,
  type DraftConstraints,
  type MatchState,
  type PoolName,
  type RoundIdx,
  type Seat,
  type Slot,
  type SlotIdx,
} from '@banpick/types'

/**
 * Spec §6 — the pool grammar.
 *
 * "Every draft rule is a set expression over tagged sets, resolved against a seat. Adding a
 * mode should never require new pool code."
 *
 * So the five named pools below are **compositions of the combinators**, not five hand-written
 * functions. The spec states the honest test of whether that was really done: D12's
 * `selfDuplicates` constraint must land as a new *term*, never a new `if`.
 *
 * It does — and slightly better than the spec's own formulation. §6 writes the constraint as
 * an inline ternary on `constraints.selfDuplicates`. Here the expression is **built from the
 * ruleset once**, at mode resolution, so a FORBIDDEN ruleset gets a tree with one more
 * subtrahend and an ALLOWED ruleset gets a tree with one fewer. Evaluation never branches on
 * configuration at all.
 */

// --- Expression language ---------------------------------------------------------------------

export type CharSetExpr =
  | { op: 'ACTIVE_ROSTER' }
  | { op: 'GLOBAL_BANNED' }
  /** The characters the *opponent's* meta ban denies to the evaluating seat. */
  | { op: 'META_BANNED_AGAINST' }
  /**
   * D12. Slot-indexed on purpose: it excludes what the seat holds in its **other** slots, so a
   * CONDITIONAL_RECOMMIT of slot 1 is not forbidden from re-selecting slot 1's own character —
   * which would be a different rule than the one D12 states.
   */
  | { op: 'SELF_HELD_OTHER_SLOTS' }
  | { op: 'CHARACTERS_OF'; slots: SlotSetExpr }
  | { op: 'DIFF'; from: CharSetExpr; minus: CharSetExpr[] }

export type SlotSetExpr =
  | { op: 'OWN_SLOTS' }
  | { op: 'OPPONENT_SLOTS' }
  | { op: 'FILTER'; from: SlotSetExpr; where: SlotPredicate[] }

export type SlotPredicate =
  { p: 'UNCONSUMED' } | { p: 'NOT_BANNED_THIS_ROUND' } | { p: 'CHARACTER_IN'; set: CharSetExpr }

export interface PoolContext {
  state: MatchState
  seat: Seat
  /** Required by `SELF_HELD_OTHER_SLOTS`; `null` outside a slot-scoped evaluation. */
  slotIndex: SlotIdx | null
  /** Required by `NOT_BANNED_THIS_ROUND`. */
  roundIndex: RoundIdx | null
}

// --- Evaluation ------------------------------------------------------------------------------

export function evalCharSet(expr: CharSetExpr, ctx: PoolContext): CharId[] {
  switch (expr.op) {
    case 'ACTIVE_ROSTER':
      return activeRoster(ctx.state.roster)

    case 'GLOBAL_BANNED':
      return ctx.state.ruleset.globalBanned

    case 'META_BANNED_AGAINST':
      return ctx.state.metaBannedAgainst[ctx.seat]

    case 'SELF_HELD_OTHER_SLOTS': {
      const slots = ctx.state.seats[ctx.seat].slots.value
      return slots.filter((s) => s.index !== ctx.slotIndex).map((s) => s.characterId)
    }

    case 'CHARACTERS_OF':
      return evalSlotSet(expr.slots, ctx).map((s) => s.characterId)

    case 'DIFF': {
      const excluded = new Set(expr.minus.flatMap((m) => evalCharSet(m, ctx)))
      return evalCharSet(expr.from, ctx).filter((id) => !excluded.has(id))
    }
  }
}

export function evalSlotSet(expr: SlotSetExpr, ctx: PoolContext): Slot[] {
  switch (expr.op) {
    case 'OWN_SLOTS':
      return ctx.state.seats[ctx.seat].slots.value

    case 'OPPONENT_SLOTS':
      return ctx.state.seats[otherSeat(ctx.seat)].slots.value

    case 'FILTER': {
      const from = evalSlotSet(expr.from, ctx)
      return from.filter((slot) => expr.where.every((pred) => holds(pred, slot, ctx)))
    }
  }
}

function holds(pred: SlotPredicate, slot: Slot, ctx: PoolContext): boolean {
  switch (pred.p) {
    case 'UNCONSUMED':
      return !slot.consumed
    case 'NOT_BANNED_THIS_ROUND':
      return slot.bannedInRound !== ctx.roundIndex
    case 'CHARACTER_IN':
      return evalCharSet(pred.set, ctx).includes(slot.characterId)
  }
}

// --- The five named pools of §6 ---------------------------------------------------------------

const ACTIVE_ROSTER: CharSetExpr = { op: 'ACTIVE_ROSTER' }
const GLOBAL_BANNED: CharSetExpr = { op: 'GLOBAL_BANNED' }
const META_BANNED_AGAINST: CharSetExpr = { op: 'META_BANNED_AGAINST' }
const SELF_HELD_OTHER_SLOTS: CharSetExpr = { op: 'SELF_HELD_OTHER_SLOTS' }

/**
 * `activeRoster \ globalBanned \ metaBannedAgainst[seat] \ selfHeld(seat, slotIdx)`
 *
 * The last term is present only when D12 is in force. That is the whole D12 implementation:
 * one more element in `minus`.
 */
export function legalDraftPoolExpr(constraints: DraftConstraints): CharSetExpr {
  const minus: CharSetExpr[] = [GLOBAL_BANNED, META_BANNED_AGAINST]
  if (constraints.selfDuplicates === 'FORBIDDEN') minus.push(SELF_HELD_OTHER_SLOTS)
  return { op: 'DIFF', from: ACTIVE_ROSTER, minus }
}

/**
 * `activeRoster \ globalBanned`
 *
 * Note what this forbids: wasting a meta ban on an already-globally-banned character. §6 calls
 * that "the payoff for keeping bans as set algebra rather than procedures", and it is — the
 * rule is not written anywhere, it falls out of the expression.
 */
export function legalMetaBanPoolExpr(): CharSetExpr {
  return { op: 'DIFF', from: ACTIVE_ROSTER, minus: [GLOBAL_BANNED] }
}

/** `seat.slots WHERE characterId ∈ metaBannedAgainst[seat]` */
export function repickTriggerExpr(): SlotSetExpr {
  return {
    op: 'FILTER',
    from: { op: 'OWN_SLOTS' },
    where: [{ p: 'CHARACTER_IN', set: META_BANNED_AGAINST }],
  }
}

/** `opponent.slots WHERE !consumed` — D3, the ban targets a slot, not a character. */
export function legalRoundBanExpr(): SlotSetExpr {
  return { op: 'FILTER', from: { op: 'OPPONENT_SLOTS' }, where: [{ p: 'UNCONSUMED' }] }
}

/** `seat.slots WHERE !consumed AND bannedInRound ≠ currentRound` */
export function legalRoundPickExpr(): SlotSetExpr {
  return {
    op: 'FILTER',
    from: { op: 'OWN_SLOTS' },
    where: [{ p: 'UNCONSUMED' }, { p: 'NOT_BANNED_THIS_ROUND' }],
  }
}

// --- Dispatch by name ------------------------------------------------------------------------

export function charPool(name: PoolName, ctx: PoolContext): CharId[] {
  switch (name) {
    case 'legalDraftPool':
      return evalCharSet(legalDraftPoolExpr(ctx.state.ruleset.constraints), ctx)
    case 'legalMetaBanPool':
      return evalCharSet(legalMetaBanPoolExpr(), ctx)
    default:
      throw new TypeError(`charPool: ${name} yields slots, not characters`)
  }
}

export function slotPool(name: PoolName, ctx: PoolContext): Slot[] {
  switch (name) {
    case 'repickTrigger':
      return evalSlotSet(repickTriggerExpr(), ctx)
    case 'legalRoundBan':
      return evalSlotSet(legalRoundBanExpr(), ctx)
    case 'legalRoundPick':
      return evalSlotSet(legalRoundPickExpr(), ctx)
    default:
      throw new TypeError(`slotPool: ${name} yields characters, not slots`)
  }
}
