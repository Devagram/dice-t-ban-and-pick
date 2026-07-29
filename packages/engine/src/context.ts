import {
  otherSeat,
  SEATS,
  type Action,
  type ActorRef,
  type EventEnvelope,
  type MatchState,
  type RejectionCode,
  type ResolvedModule,
  type RoundIdx,
  type RoundState,
  type Seat,
  type SliceName,
} from '@banpick/types'

/** What a phase module is handed. Nothing else is in scope for it. */
export interface ModuleCtx<M extends ResolvedModule = ResolvedModule> {
  state: MatchState
  mod: M
}

export type ApplyResult =
  { ok: true; state: MatchState } | { ok: false; code: RejectionCode; detail: string }

export function reject(code: RejectionCode, detail: string): ApplyResult {
  return { ok: false, code, detail }
}

/**
 * Spec §8 — "Each declares the state slices it reads and writes."
 *
 * Phase 2's loader consumes this metadata for the slice-dependency validator; the engine itself
 * only needs it to be honest.
 */
export interface PhaseModule<M extends ResolvedModule = ResolvedModule> {
  reads: readonly SliceName[]
  writes: readonly SliceName[]
  /**
   * Whether a round can still meet its obligations with this module removed. Consumed by
   * Phase 2's *transition preservation* validator (§13).
   *
   * §13 words that validator as "`remove` may not name a module that writes a state slice".
   * Taken literally it rejects the shipped base mode: `BAN` writes `bannedInRound`, and round 2
   * removes `BAN` because round 2 genuinely has no ban (D11). Nothing is left un-transitioned —
   * the round simply contains no denial.
   *
   * What D13 actually caught was different in kind. Round 2 removed `SELECT`, so `consumed`
   * never moved and the log held no record that the slot was played. The distinguishing
   * property is not "writes a slice", it is **"the round cannot complete without it"**:
   * `SELECT` spends a slot and `REPORT_RESULT` produces the result the match rule scores.
   * Remove either and the match cannot terminate.
   */
  essential: boolean
  /** Seats this module is waiting on. Empty means it needs no human. */
  awaiting(ctx: ModuleCtx<M>): Seat[]
  legalActions(ctx: ModuleCtx<M>, seat: Seat): Action[]
  /**
   * The SYSTEM-authored event this module wants next, if any: a roll, a reveal, the D10
   * inversion, or D26's forced select. Returning an event rather than appending one is what
   * keeps `reduce` single-event and pure — the caller drains this in a loop.
   */
  systemEvent(ctx: ModuleCtx<M>, seq: number): EventEnvelope | null
  /**
   * Only ever called by `reduce`, and only after it has confirmed the event names *this*
   * module — so an implementation checks the payload's shape and its own rules, never the
   * module id. That check lives in one place because it needs one answer: Phase 3 layers
   * idempotency on the rejection codes, and "you already did that" has to be distinguishable
   * from "that is not a thing you can do".
   */
  apply(ctx: ModuleCtx<M>, event: EventEnvelope): ApplyResult
  isComplete(ctx: ModuleCtx<M>): boolean
}

// --- State helpers -----------------------------------------------------------------------------

/**
 * `reduce` is pure with respect to its input: it clones, edits the clone, and returns it. The
 * purity gate deep-freezes the input, so a missed clone fails the test rather than the review.
 *
 * A full match is a few dozen events over a few kilobytes, so the quadratic cost of cloning per
 * event is not worth the nested-spread code it would save.
 *
 * Hand-written rather than `structuredClone`, for two reasons. It is a host global, so reaching
 * for it means either widening the engine's lib to DOM — handing a pure rules package a pile of
 * browser types — or declaring an ambient the no-IO lint exists to prevent. And match state is
 * plain JSON-shaped data by construction (it has to be: it is serialized to the wire and to
 * SQLite), so a structural clone is not a simplification, it is the exact semantics.
 */
export function cloneState(state: MatchState): MatchState {
  return deepClone(state)
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(deepClone) as T

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepClone(v)
  }
  return out as T
}

export function currentModule(state: MatchState): ResolvedModule | null {
  return state.mode.program[state.cursor] ?? null
}

export function roundOf(state: MatchState, mod: ResolvedModule): RoundState {
  if (mod.roundIndex === null) {
    throw new TypeError(`roundOf: module ${mod.id} does not belong to a round`)
  }
  const round = state.rounds[mod.roundIndex]
  if (!round) throw new TypeError(`roundOf: no round state at index ${mod.roundIndex}`)
  return round
}

/**
 * Actor references are relative so the round template can be written once and the overrides
 * only have to move the assignment (D10, D11).
 */
export function resolveActor(state: MatchState, mod: ResolvedModule, ref: ActorRef): Seat[] {
  if (ref === 'BOTH') return [...SEATS]

  const round = roundOf(state, mod)
  switch (ref) {
    case 'rollWinner':
      return round.roll ? [round.roll.winner] : []
    case 'privilegeHolder':
      return round.privilegeHolder ? [round.privilegeHolder] : []
    case 'turnOrderHolder':
      return round.turnOrderHolder ? [round.turnOrderHolder] : []
    case 'opponent':
      // The opponent *of the privilege holder* — §9.1's select order is written from the
      // privilege holder's point of view.
      return round.privilegeHolder ? [otherSeat(round.privilegeHolder)] : []
  }
}

export function findRoundIndex(mod: ResolvedModule): RoundIdx {
  if (mod.roundIndex === null) {
    throw new TypeError(`module ${mod.id} has no round index`)
  }
  return mod.roundIndex
}

export function envelope(
  seq: number,
  tag: string,
  actor: EventEnvelope['actor'],
  payload: EventEnvelope['payload'],
): EventEnvelope {
  return { v: 1, seq, tag, actor, payload }
}
