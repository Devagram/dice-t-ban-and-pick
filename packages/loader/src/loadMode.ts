import { ModeResolutionError, resolveMode, type ResolutionErrorCode } from '@banpick/engine'
import type { ModeDefinition, ResolvedMode, Roster, RoundLoopSpec } from '@banpick/types'

import { issue, ModeLoadError, type LoadErrorCode, type LoadIssue } from './errors.js'
import { modeContentHash } from './hash.js'
import { parseMode, SCHEMA_VERSION } from './parse.js'
import {
  parameterCombinations,
  validateRevealReachability,
  validateRosterViability,
  validateSliceDependency,
  validateTermination,
  validateTransitionPreservation,
  validateUniqueIds,
} from './validators.js'

/**
 * Resolution failures are §13 failures wearing a different name.
 *
 * A DEFERRED reveal with no downstream gate is caught during resolution simply because a tag
 * cannot be bound — but it is *reveal reachability*, and a failure fixture is only meaningful if
 * it fails under the rule it was written to break.
 */
const LOAD_CODE_OF: Record<ResolutionErrorCode, LoadErrorCode> = {
  PARAMETER_INVALID: 'PARAMETER_SPACE',
  REVEAL_UNREACHABLE: 'REVEAL_UNREACHABLE',
  REMOVE_UNKNOWN_MODULE: 'RESOLUTION_FAILED',
  SELECT_ORDER_ARITY: 'RESOLUTION_FAILED',
  SELECT_OVERRIDE_TARGET: 'RESOLUTION_FAILED',
  NESTED_ROUND_LOOP: 'RESOLUTION_FAILED',
  ROUND_INDEX_RANGE: 'RESOLUTION_FAILED',
  REPORT_OVERRIDE_TARGET: 'RESOLUTION_FAILED',
}

/** One validated parameter combination (D25), ready for the lobby to offer. */
export interface LoadedVariant {
  parameters: Record<string, string | number>
  mode: ResolvedMode
  /** D20. Covers the mode content *and* the resolved parameters. */
  modeContentHash: string
}

export interface LoadedMode {
  modeId: string
  schemaVersion: number
  definition: ModeDefinition
  /** Every declared combination, all validated. Never a subset. */
  variants: LoadedVariant[]
}

export interface LoadOptions {
  /**
   * Checked against the §13 roster floor. `globalBanned` is deliberately not a parameter here:
   * the host has not chosen bans at load time, so this validates the roster alone can support
   * the mode. The lobby re-checks with the host's actual bans — see `validateRosterViability`.
   */
  roster: Roster
}

/**
 * Phase 2's deliverable, and the point of the whole architecture.
 *
 * §1 requires that "new modes must be config, never engine code", and that claim is unproven
 * until a mode can travel from YAML to a running match without touching the engine. This is the
 * function that makes it true — and the acceptance test is literally that its output is
 * deep-equal to what Phase 1 built by hand.
 *
 * Everything is validated **before** anything is returned. There is no partially-loaded mode,
 * which is what makes "no mode file can reach the engine without passing validation" structural
 * rather than a convention: `LoadedMode` is the only way to obtain a `ResolvedMode` from a file,
 * and it does not exist unless every check passed.
 */
export function loadModeFromSource(source: string, ref: string, opts: LoadOptions): LoadedMode {
  const parsed = parseMode(source, ref)
  if (parsed.definition === null) throw new ModeLoadError(ref, parsed.issues)

  const def = parsed.definition
  const issues: LoadIssue[] = []

  // Static checks — the ones that do not depend on which parameters were chosen.
  const loops = def.modules.filter((m): m is RoundLoopSpec => m.type === 'ROUND_LOOP')
  for (const loop of loops) issues.push(...validateTransitionPreservation(loop, ref))
  issues.push(...validateTermination(def.onTie, def.match, def.overtime, ref, def.modules))

  const { combinations, issues: paramIssues } = parameterCombinations(def, ref)
  issues.push(...paramIssues)

  // D25 — every declared combination passes every other validator, at load time. A
  // parameterized mode validated only for its defaults is an unvalidated mode.
  const variants: LoadedVariant[] = []
  for (const parameters of combinations) {
    const label = describe(parameters)
    let resolved: ResolvedMode
    try {
      resolved = resolveMode(def, parameters)
    } catch (e) {
      issues.push(
        issue(
          e instanceof ModeResolutionError ? LOAD_CODE_OF[e.code] : 'RESOLUTION_FAILED',
          `${ref}${label}`,
          e instanceof Error ? e.message : String(e),
        ),
      )
      continue
    }

    issues.push(...validateUniqueIds(resolved.program, `${ref}${label}`))
    issues.push(...validateSliceDependency(resolved.program, `${ref}${label}`))
    issues.push(...validateRevealReachability(resolved.program, `${ref}${label}`))

    const draftCount = draftCountOf(resolved)
    if (draftCount !== null) {
      issues.push(...validateRosterViability(opts.roster, [], draftCount, `${ref}${label}`))
    }

    variants.push({
      parameters,
      mode: resolved,
      modeContentHash: modeContentHash(def.modeId, def, parameters),
    })
  }

  if (issues.length > 0) throw new ModeLoadError(ref, issues)

  return {
    modeId: def.modeId,
    schemaVersion: SCHEMA_VERSION,
    definition: def,
    variants,
  }
}

/** Picks the variant a host chose. Throws rather than resolving on the fly — see above. */
export function variantFor(
  loaded: LoadedMode,
  parameters: Record<string, string | number>,
): LoadedVariant {
  const found = loaded.variants.find((v) =>
    Object.entries(parameters).every(([k, val]) => v.parameters[k] === val),
  )
  if (!found) {
    throw new RangeError(
      `${loaded.modeId}: no validated variant for ${describe(parameters)}. ` +
        'Every offerable combination is enumerated at load; this one was not declared.',
    )
  }
  return found
}

/** The variant a host gets if they touch nothing. */
export function defaultVariant(loaded: LoadedMode): LoadedVariant {
  const defaults: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(loaded.definition.parameters)) {
    defaults[name] = spec.default
  }
  return variantFor(loaded, defaults)
}

/** The §13 floor is keyed to `draftCount`; a mode without one is not draft-limited. */
function draftCountOf(mode: ResolvedMode): number | null {
  const commit = mode.program.find((m) => m.type === 'SIMULTANEOUS_COMMIT' && m.commits.picks)
  return commit && commit.type === 'SIMULTANEOUS_COMMIT' && commit.commits.picks
    ? commit.commits.picks.count
    : null
}

function describe(parameters: Record<string, string | number>): string {
  const entries = Object.entries(parameters)
  if (entries.length === 0) return ''
  return `[${entries.map(([k, v]) => `${k}=${String(v)}`).join(',')}]`
}
