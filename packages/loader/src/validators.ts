import { moduleFor } from '@banpick/engine'
import {
  activeRoster,
  ROUND_COUNT,
  type CharId,
  type MatchRule,
  type ModeDefinition,
  type ModuleSpec,
  type OvertimeRule,
  type ResolvedModule,
  type Roster,
  type RoundLoopSpec,
  type SliceName,
  type TieRule,
} from '@banpick/types'

import { issue, type LoadIssue } from './errors.js'

/**
 * Spec §13 — the load-time validators.
 *
 * All six run against the **resolved** program, not the YAML, and against every declared
 * parameter combination (D25). A mode that reaches the engine has passed all of them; that is
 * what "no mode file can reach the engine without passing validation, enforced structurally"
 * means in practice, since the loader is the only thing that produces a `ResolvedMode`.
 */

/** D25 — a parameter space larger than this is a mode nobody is really validating. */
export const PARAMETER_SPACE_CAP = 32

// --- 1. Slice dependency -----------------------------------------------------------------------

/**
 * "Every module's read set is satisfied by an upstream write."
 *
 * The read/write metadata comes from the engine's own module implementations rather than being
 * restated here. A loader with its own idea of what a module touches would be a second
 * implementation of the rules, which is precisely what D18 exists to prevent.
 */
export function validateSliceDependency(program: ResolvedModule[], path: string): LoadIssue[] {
  const issues: LoadIssue[] = []
  const written = new Set<SliceName>()

  for (const mod of program) {
    const impl = moduleFor(mod)
    for (const slice of impl.reads) {
      if (!written.has(slice)) {
        issues.push(
          issue(
            'SLICE_DEPENDENCY',
            `${path}/${mod.id}`,
            `reads '${slice}', which no upstream module writes`,
          ),
        )
      }
    }
    for (const slice of impl.writes) written.add(slice)
  }

  return issues
}

// --- 2. Roster viability -----------------------------------------------------------------------

/**
 * `|activeRoster| - |globalBans| >= draftCount + 1`
 *
 * Derived, not asserted, and the derivation matters because the bound changes if D12 flips.
 * Let `N = |activeRoster| - |globalBans|`. Worst case is a seat whose meta ban lands:
 *
 *   - the seat needs `draftCount` **distinct** characters (D12 forbids self-duplicates)
 *   - one is unavailable to it (`metaBannedAgainst[seat]`, one ID by `count: 1`)
 *   - therefore `N - 1 >= draftCount`, so `N >= draftCount + 1`
 *
 * Had D12 gone the other way, one legal character could fill every slot and the true bound
 * would be `N >= 2`. Same validator, entirely different number.
 *
 * **Called twice, on purpose.** At load time `globalBanned` is empty — the host has not chosen
 * yet — so this checks the roster alone can support the mode. The lobby must call it again with
 * the host's actual bans before `SEAT_FILLED`, because a host can ban a match into
 * unplayability that no load-time check could have seen.
 */
export function validateRosterViability(
  roster: Roster,
  globalBanned: CharId[],
  draftCount: number,
  path: string,
): LoadIssue[] {
  const banned = new Set(globalBanned)
  const available = activeRoster(roster).filter((id) => !banned.has(id)).length
  const floor = draftCount + 1

  if (available < floor) {
    return [
      issue(
        'ROSTER_VIABILITY',
        path,
        `${available} draftable characters, but drafting ${draftCount} with a meta ban needs at ` +
          `least ${floor}. (Retired characters do not count; ${globalBanned.length} globally banned.)`,
      ),
    ]
  }
  return []
}

// --- 3. Reveal reachability --------------------------------------------------------------------

/**
 * "Every `revealedBy` tag is emitted by some module in the mode."
 *
 * A sealed slice whose gate never fires is sealed forever, and the failure would surface as two
 * players staring at a screen that never advances.
 *
 * `resolveMode` already throws on the common case (a DEFERRED commit with no downstream REVEAL)
 * because it cannot bind a tag it cannot find. This checks the resolved program independently,
 * so the guarantee does not rest on resolution having been careful.
 */
export function validateRevealReachability(program: ResolvedModule[], path: string): LoadIssue[] {
  const issues: LoadIssue[] = []
  const emitted = new Set<string>()

  for (const mod of program) {
    // Anything that can fire a REVEAL contributes its tag. SIMULTANEOUS_COMMIT reveals at its
    // own gate; a standalone REVEAL is nothing but a gate; a hidden simultaneous SELECT opens
    // itself once both seats have picked.
    if (mod.type === 'SIMULTANEOUS_COMMIT' || mod.type === 'REVEAL') emitted.add(`${mod.id}:reveal`)
    if (mod.type === 'SELECT' && mod.mode === 'SIMULTANEOUS_HIDDEN') emitted.add(`${mod.id}:reveal`)
  }

  for (const mod of program) {
    const tags: (string | null)[] =
      mod.type === 'SIMULTANEOUS_COMMIT'
        ? [mod.revealTags.picks, mod.revealTags.metaBan]
        : mod.type === 'CONDITIONAL_RECOMMIT'
          ? [mod.revealTag]
          : []

    for (const tag of tags) {
      if (tag !== null && !emitted.has(tag)) {
        issues.push(
          issue(
            'REVEAL_UNREACHABLE',
            `${path}/${mod.id}`,
            `seals a slice with tag '${tag}', which no module in this mode emits`,
          ),
        )
      }
    }
  }

  return issues
}

// --- 4. Transition preservation ----------------------------------------------------------------

/**
 * D13 — "`remove` may delete a *decision*, never a *state transition*."
 *
 * §13 words this as "`remove` may not name a module that writes a state slice". Taken literally
 * it rejects the shipped base mode: `BAN` writes `bannedInRound`, and round 2 removes `BAN`
 * because round 2 genuinely has no ban (D11). Nothing is left un-transitioned.
 *
 * The property that actually distinguishes the bug D13 caught is whether the round can still
 * meet its obligations, which each module declares as `essential` — see the note on
 * `PhaseModule` in the engine. `SELECT` spends a slot; `REPORT_RESULT` produces the result the
 * match rule scores.
 *
 * D26 means nothing in the shipped modes trips this any more, which is the correct end state
 * for a guardrail.
 */
export function validateTransitionPreservation(loop: RoundLoopSpec, path: string): LoadIssue[] {
  const issues: LoadIssue[] = []
  const byId = new Map(loop.template.map((m) => [m.id, m]))

  for (const [round, override] of Object.entries(loop.overrides)) {
    for (const id of override?.remove ?? []) {
      const spec = byId.get(id)
      if (!spec) continue // reported separately by resolution
      // `moduleFor` wants a resolved module; only `type` is read, so a shim is honest here.
      const impl = moduleFor({ ...spec, roundIndex: null } as ResolvedModule)
      if (impl.essential) {
        issues.push(
          issue(
            'TRANSITION_REMOVED',
            `${path}/${loop.id}/overrides/${round}`,
            `removes '${id}' (${spec.type}), which the round cannot complete without. ` +
              'A decision with one option auto-commits (D26); it is not removed.',
          ),
        )
      }
    }
  }

  return issues
}

// --- 5. Parameter space ------------------------------------------------------------------------

/** D25 — every declared combination, enumerated so every other validator can run on all of them. */
export function parameterCombinations(
  def: ModeDefinition,
  path: string,
): { combinations: Record<string, string | number>[]; issues: LoadIssue[] } {
  const names = Object.keys(def.parameters)
  let combinations: Record<string, string | number>[] = [{}]

  for (const name of names) {
    const spec = def.parameters[name]!
    if (!spec.values.includes(spec.default)) {
      return {
        combinations: [],
        issues: [
          issue(
            'PARAMETER_SPACE',
            `${path}/parameters/${name}`,
            `default ${String(spec.default)} is not among its declared values [${spec.values.join(', ')}]`,
          ),
        ],
      }
    }
    combinations = combinations.flatMap((base) =>
      spec.values.map((value) => ({ ...base, [name]: value })),
    )
    if (combinations.length > PARAMETER_SPACE_CAP) {
      return {
        combinations: [],
        issues: [
          issue(
            'PARAMETER_SPACE',
            `${path}/parameters`,
            `declares more than ${PARAMETER_SPACE_CAP} combinations. A parameterized mode ` +
              'validated only for its defaults is an unvalidated mode, so the space has to stay ' +
              'small enough to check exhaustively.',
          ),
        ],
      }
    }
  }

  return { combinations, issues: [] }
}

// --- 6. Termination --------------------------------------------------------------------------

/**
 * G14 — "every `(scoring, resolution, overtime)` triple must be provably terminating".
 *
 * The legal set is small enough to be a lookup table rather than an analysis. Under D21 it has
 * one row, and the validator exists to keep it that way.
 *
 * The row that is *not* here is the reason it exists: `HALF_POINT` + `FIRST_TO_2` + no overtime
 * reaches 1.5–1.5 after three rounds with every character consumed and no mechanism to break
 * the deadlock. A loader without this check accepts it happily, and the failure arrives in
 * front of two players with nothing left to play.
 */
const TERMINATING: readonly string[] = [
  'HALF_POINT|ALWAYS_3_ROUNDS|false',
  // D30. Terminating for a reason the key cannot express, which is why `validateTermination`
  // also checks the overtime round itself: overtime is only a decider if it forbids ties.
  'HALF_POINT|ALWAYS_3_ROUNDS|true',
]

export function validateTermination(
  onTie: TieRule,
  match: MatchRule,
  overtime: OvertimeRule,
  path: string,
  modules: ModuleSpec[] = [],
): LoadIssue[] {
  const key = `${onTie.scoring}|${match.resolution}|${overtime.enabled}`
  if (!TERMINATING.includes(key)) {
    return [
      issue(
        'NON_TERMINATING',
        path,
        `(${key.split('|').join(', ')}) is not a provably terminating combination. ` +
          `Legal triples: ${TERMINATING.join(', ')}`,
      ),
    ]
  }

  if (!overtime.enabled) return []

  /*
   * D30 — the argument that overtime terminates, checked rather than assumed.
   *
   * Regulation can only reach overtime level, so overtime must produce a lead. A tie-allowing
   * overtime round ends 2.0–2.0 with every character consumed and nothing left to play, which is
   * the same deadlock the table above was written to keep out — reached by a longer path.
   *
   * The check is on the round's own override rather than on the resolved program because the
   * override is where a mode author writes it, and an error pointing at a generated module index
   * is an error nobody can act on.
   */
  const issues: LoadIssue[] = []
  for (const mod of modules) {
    if (mod.type !== 'ROUND_LOOP') continue
    const overtimeRound = mod.overrides[ROUND_COUNT]
    if (overtimeRound?.report?.allowTie === false) continue
    issues.push(
      issue(
        'NON_TERMINATING',
        `${path}/${mod.id}`,
        `overtime is enabled, so round ${ROUND_COUNT} must set 'report: { allowTie: false }'. ` +
          `An overtime round that can tie leaves 2.0-2.0 with no characters left to play.`,
      ),
    )
  }
  return issues
}

// --- Structural: duplicate ids -----------------------------------------------------------------

/** `remove` names modules by id, so two modules sharing one makes an override ambiguous. */
export function validateUniqueIds(program: ResolvedModule[], path: string): LoadIssue[] {
  const seen = new Set<string>()
  const issues: LoadIssue[] = []
  for (const mod of program) {
    if (seen.has(mod.id)) {
      issues.push(issue('DUPLICATE_MODULE_ID', `${path}/${mod.id}`, 'is declared more than once'))
    }
    seen.add(mod.id)
  }
  return issues
}
