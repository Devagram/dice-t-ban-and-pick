import {
  ENGINE_VERSION,
  legalActions,
  reduce,
  resolveMode,
  settle,
  systemStep,
} from '@banpick/engine'
import {
  activeRoster,
  canonicalJson,
  otherSeat,
  SEATS,
  type Action,
  type CharId,
  type DraftConstraints,
  type EventPayload,
  type MatchState,
  type ModeDefinition,
  type Roster,
  type RoundOutcome,
  type Ruleset,
  type Seat,
} from '@banpick/types'

import rosterJson from '../../../roster/roster.json' with { type: 'json' }
import roster75Json from '../../../roster/roster.75.fixture.json' with { type: 'json' }

export const ROSTER_10 = rosterJson as Roster
export const ROSTER_75 = roster75Json as Roster

const CONSTRAINTS: DraftConstraints = {
  crossSeatMirrors: 'ALLOWED', // D1
  selfDuplicates: 'FORBIDDEN', // D12
}

export interface MatchOptions {
  mode: ModeDefinition
  draftCount: 3 | 4
  seed?: string
  roster?: Roster
  globalBanned?: CharId[]
  /** Overridable so a test can exercise G3's blast-radius case with D12 relaxed. */
  constraints?: Partial<DraftConstraints>
}

/**
 * Builds a match and seats both players, leaving it at the first module that wants a human.
 *
 * `settle` runs after every step, which is how a caller is meant to drive the engine: `reduce`
 * takes exactly one event, and everything nobody decided (rolls, reveals, D10's inversion,
 * D26's forced selects) arrives through `systemStep`.
 */
export function startMatch(opts: MatchOptions): MatchState {
  const roster = opts.roster ?? ROSTER_10
  const resolved = resolveMode(opts.mode, { draftCount: opts.draftCount })

  const ruleset: Ruleset = {
    modeId: resolved.modeId,
    parameters: resolved.parameters,
    rosterVersion: roster.rosterVersion,
    globalBanned: opts.globalBanned ?? [],
    constraints: { ...CONSTRAINTS, ...opts.constraints },
    onTie: resolved.onTie,
    match: resolved.match,
    overtime: resolved.overtime,
    // Phase 2 computes this for real over the canonical mode content. Here it only has to be
    // stable, so the test fixtures are stable.
    modeContentHash: `test-${resolved.modeId}-${opts.draftCount}`,
  }

  let state = expectOk(
    reduce(null, {
      v: 1,
      seq: 0,
      tag: 'match:created',
      actor: 'SYSTEM',
      payload: {
        type: 'MATCH_CREATED',
        seed: opts.seed ?? 'phase-1-fixture-seed',
        ruleset,
        roster,
        mode: resolved,
        engineVersion: ENGINE_VERSION,
      },
    }),
  )

  for (const seat of SEATS) {
    state = apply(state, seat, { type: 'SEAT_FILLED', seat })
  }
  return state
}

/** Appends one player-authored event, then drains everything the system owes in response. */
export function apply(
  state: MatchState,
  actor: Seat | 'SYSTEM',
  payload: EventPayload,
): MatchState {
  const next = expectOk(
    reduce(state, { v: 1, seq: state.log.length, tag: tagFor(payload), actor, payload }),
  )
  return settle(next)
}

export function expectOk(result: ReturnType<typeof reduce>): MatchState {
  if (!result.ok) throw new Error(`reduce rejected: ${result.code} — ${result.detail}`)
  return result.state
}

export function expectRejected(result: ReturnType<typeof reduce>): {
  code: string
  detail: string
} {
  if (result.ok) throw new Error('reduce accepted an event the test expected it to reject')
  return { code: result.code, detail: result.detail }
}

function tagFor(payload: EventPayload): string {
  return 'moduleId' in payload ? `${payload.moduleId}:${payload.type}` : payload.type
}

// --- Driving a whole match ---------------------------------------------------------------------

export function currentAction<T extends Action['type']>(
  state: MatchState,
  seat: Seat,
  type: T,
): Extract<Action, { type: T }> | null {
  const found = legalActions(state, seat).find((a) => a.type === type)
  return (found as Extract<Action, { type: T }> | undefined) ?? null
}

export function awaiting(state: MatchState): Seat[] {
  return SEATS.filter((seat) =>
    legalActions(state, seat).some((a) => a.type !== 'UNDO_LAST_RESULT'),
  )
}

/** A deterministic "player": always takes the first legal option offered. */
export function playFirstLegal(state: MatchState, seat: Seat): MatchState {
  const action = legalActions(state, seat).find((a) => a.type !== 'UNDO_LAST_RESULT')
  if (!action) throw new Error(`seat ${seat} has no legal action`)
  return apply(state, seat, materialize(action, seat))
}

/**
 * Turns an option-space `Action` into one concrete event.
 *
 * `legalActions` describes what is available rather than enumerating every submission (drafting
 * 4 from 75 is over a million combinations), so the legality-soundness gate needs this bridge
 * to close the loop between "offered" and "accepted".
 */
export function materialize(action: Action, seat: Seat, pickOffset = 0): EventPayload {
  switch (action.type) {
    case 'FILL_SEAT':
      return { type: 'SEAT_FILLED', seat }

    case 'COMMIT': {
      const picks: CharId[] = []
      if (action.picks) {
        for (const pool of action.picks.poolBySlot) {
          // D12: distinct within the seat, so skip anything already taken.
          const choice =
            pool.filter((id) => !picks.includes(id))[pickOffset % pool.length] ??
            pool.find((id) => !picks.includes(id))
          if (choice === undefined) throw new Error('materialize: pool exhausted')
          picks.push(choice)
        }
      }
      return {
        type: 'COMMIT',
        moduleId: action.moduleId,
        seat,
        picks,
        metaBan: action.metaBan
          ? (action.metaBan.pool[pickOffset % action.metaBan.pool.length] ?? null)
          : null,
      }
    }

    case 'RECOMMIT': {
      const taken: CharId[] = []
      return {
        type: 'RECOMMIT',
        moduleId: action.moduleId,
        seat,
        replacements: action.slots.map((slot) => {
          const choice = slot.pool.find((id) => !taken.includes(id))
          if (choice === undefined) throw new Error('materialize: recommit pool exhausted')
          taken.push(choice)
          return { index: slot.index, characterId: choice }
        }),
      }
    }

    case 'CHOOSE':
      return {
        type: 'CHOOSE',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        option: action.options[pickOffset % action.options.length]!,
      }

    case 'BAN': {
      const target = action.targets[pickOffset % action.targets.length]!
      return {
        type: 'BAN',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        tier: 'ROUND',
        target,
      }
    }

    case 'SELECT':
      return {
        type: 'SELECT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        slotIndex: action.slots[pickOffset % action.slots.length]!,
        reason: null,
      }

    case 'REPORT_RESULT':
      return {
        type: 'REPORT_RESULT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        reportedBy: seat,
        outcome: action.outcomes[pickOffset % action.outcomes.length]!,
      }

    case 'UNDO_LAST_RESULT':
      return { type: 'UNDO_LAST_RESULT', roundIndex: action.roundIndex, requestedBy: seat }
  }
}

/**
 * Plays until `stop` is satisfied, reporting `results[n]` for round n and taking the first legal
 * option everywhere else.
 *
 * Rounds 0 and 1 usually want a 1-1 split: at 2-0 `stopWhenDecided` correctly ends the match
 * before round 2 is ever played, which is right and is not what most tests are trying to reach.
 */
export function driveUntil(
  state: MatchState,
  stop: (s: MatchState) => boolean,
  results: RoundOutcome[] = ['A', 'B', 'A'],
): MatchState {
  let current = state

  for (let guard = 0; guard < 200; guard++) {
    if (stop(current)) return current
    if (current.status === 'COMPLETE') return current

    const seat = awaiting(current)[0]
    if (!seat) {
      const sys = systemStep(current)
      if (!sys) return current
      current = settle(expectOk(reduce(current, sys)))
      continue
    }

    const report = currentAction(current, seat, 'REPORT_RESULT')
    current = report
      ? apply(current, seat, {
          type: 'REPORT_RESULT',
          moduleId: report.moduleId,
          roundIndex: report.roundIndex,
          reportedBy: seat,
          outcome: results[report.roundIndex] ?? 'A',
        })
      : playFirstLegal(current, seat)
  }
  throw new Error('driveUntil: stop condition never satisfied')
}

/** True once the cursor sits on the named module — the readable way to say "stop here". */
export function atModule(id: string) {
  return (s: MatchState) => s.mode.program[s.cursor]?.id === id
}

/**
 * Plays a match to a terminal state, taking `results[n]` for round n and the first legal option
 * everywhere else.
 */
export function playMatch(
  state: MatchState,
  results: RoundOutcome[] = ['A', 'A', 'A'],
): MatchState {
  let current = state
  let guard = 0

  while (current.status === 'IN_PROGRESS') {
    if (guard++ > 200) throw new Error('playMatch: match did not terminate')

    const waiting = awaiting(current)
    if (waiting.length === 0) {
      const sys = systemStep(current)
      if (!sys) throw new Error('playMatch: nobody can act and no system event is pending')
      current = settle(expectOk(reduce(current, sys)))
      continue
    }

    const seat = waiting[0]!
    const report = currentAction(current, seat, 'REPORT_RESULT')
    if (report) {
      const outcome = results[report.roundIndex] ?? 'A'
      current = apply(current, seat, {
        type: 'REPORT_RESULT',
        moduleId: report.moduleId,
        roundIndex: report.roundIndex,
        reportedBy: seat,
        outcome,
      })
      continue
    }

    current = playFirstLegal(current, seat)
  }

  return current
}

// --- Assertions ---------------------------------------------------------------------------------

export function digest(state: MatchState): string {
  return canonicalJson(state)
}

export function charactersOf(state: MatchState, seat: Seat): CharId[] {
  return state.seats[seat].slots.value.map((s) => s.characterId)
}

/** Everything draftable in a match, before any per-seat term applies. */
export function draftableIds(state: MatchState): CharId[] {
  return activeRoster(state.roster).filter((id) => !state.ruleset.globalBanned.includes(id))
}

export { otherSeat, SEATS }
