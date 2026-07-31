import {
  bringBan1Mode,
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

// The engine's own fixture, not the game roster. Rules are not roster data: a test that
// breaks when a character is added is testing the wrong thing.
import rosterJson from './fixtures/roster.json' with { type: 'json' }
import roster75Json from '../../../roster/roster.75.fixture.json' with { type: 'json' }

export const ROSTER_10 = rosterJson as Roster
export const ROSTER_75 = roster75Json as Roster

const CONSTRAINTS: DraftConstraints = {
  crossSeatMirrors: 'ALLOWED', // D1
  selfDuplicates: 'FORBIDDEN', // D12
}

/**
 * A mode that bans **blind, alongside the draft**, and therefore needs a repick.
 *
 * This was `bring-ban1`'s shape until 2026-07-31, when the ban moved in front of the draft and
 * took `CONDITIONAL_RECOMMIT`'s reason for existing with it. No shipped mode uses that module
 * now — but it is one of §8's nine, and the whole architectural bet (D25, Phase 6) is that
 * modules are composable pieces a *future* mode can pick up. Deleting a documented capability
 * because today's two modes happen not to use it would be quietly narrowing the system.
 *
 * So the module keeps its implementation and its tests, and the tests own a mode to run it
 * against. That is also more honest than what came before: these were always tests of
 * `CONDITIONAL_RECOMMIT`, and they only looked like tests of `bring-ban1`.
 */
export const blindBanMode: ModeDefinition = {
  modeId: 'blind-ban-fixture',
  label: 'Blind ban, then repick',
  parameters: { draftCount: { values: [3, 4], default: 4, label: 'Characters drafted' } },
  modules: [
    {
      type: 'SIMULTANEOUS_COMMIT',
      id: 'draft',
      commits: {
        picks: { count: { param: 'draftCount' }, pool: 'legalDraftPool' },
        metaBan: { count: 1, pool: 'legalMetaBanPool', tier: 'META', targets: 'OPPONENT_ONLY' },
      },
      reveal: { picks: 'DEFERRED', metaBan: 'IMMEDIATE' },
    },
    {
      type: 'CONDITIONAL_RECOMMIT',
      id: 'repick',
      trigger: 'repickTrigger',
      pool: 'legalDraftPool',
      hidden: true,
    },
    { type: 'REVEAL', id: 'pickReveal', slices: ['slots'] },
    // Borrowed from the shipped mode rather than copied, so this fixture cannot drift into
    // testing a round loop the real game does not play.
    bringBan1Mode.modules[bringBan1Mode.modules.length - 1]!,
  ],
  // Same values as the shipped modes' shared constants, which the engine barrel does not export.
  onTie: { scoring: 'HALF_POINT', consumesCharacters: true },
  match: { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true },
  overtime: { enabled: false },
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
 * Plays the current `SIMULTANEOUS_COMMIT` for both seats, whatever it happens to ask for.
 *
 * Named by intent rather than by module id on purpose. `bring-ban1` used to have one commit
 * carrying picks *and* a ban; it now has two — ban, then draft — and a test that hardcoded
 * `moduleId: 'draft'` was really asserting the shape of the mode file from across the codebase.
 * Anything that genuinely cares which phase it is in should say so by asserting, not by naming.
 */
export function commitPhase(
  state: MatchState,
  offsets: Partial<Record<Seat, number>> = {},
): MatchState {
  let current = state
  for (const seat of SEATS) {
    const action = currentAction(current, seat, 'COMMIT')
    if (!action) continue
    current = apply(current, seat, materialize(action, seat, offsets[seat] ?? 0))
  }
  return current
}

/** Drains every consecutive commit phase — one call to get from match start to a full draft. */
export function commitAll(
  state: MatchState,
  offsets: Partial<Record<Seat, number>> = {},
): MatchState {
  let current = state
  for (let guard = 0; guard < 8; guard++) {
    if (!SEATS.some((s) => currentAction(current, s, 'COMMIT'))) return current
    current = commitPhase(current, offsets)
  }
  throw new Error('commitAll: still committing after 8 phases')
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
