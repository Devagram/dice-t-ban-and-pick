import type { ResolvedMode, Ruleset } from '@banpick/types'

import bundle from './generated/modes.json' with { type: 'json' }

/**
 * The pre-validated modes, bundled at build time.
 *
 * The Durable Object cannot run the loader: the schema validator compiles with `new Function`,
 * which Workers forbid. That constraint happens to agree with the design — §13's argument is
 * that a mode which cannot work should fail at **deploy**, not mid-match — so the worker
 * receives already-parsed, already-validated, already-hashed data and has no way to obtain a
 * mode by any other route.
 *
 * `packages/loader/test/generate-modes.test.ts` produces this and fails if `modes/*.yaml` has
 * been edited without regenerating.
 */

export interface BundledVariant {
  parameters: Record<string, string | number>
  mode: ResolvedMode
  modeContentHash: string
}

export interface BundledMode {
  modeId: string
  schemaVersion: number
  definition: {
    label: string
    parameters: Record<
      string,
      { values: (string | number)[]; default: string | number; label: string }
    >
  }
  variants: BundledVariant[]
}

const MODES = bundle.modes as unknown as Record<string, BundledMode>

export const ROSTER_VERSION = bundle.rosterVersion as string

export function listModes(): BundledMode[] {
  return Object.values(MODES)
}

export function findMode(modeId: string): BundledMode | null {
  return MODES[modeId] ?? null
}

/**
 * Picks the variant a host chose.
 *
 * Returns `null` rather than resolving on the fly, deliberately: every offerable combination
 * was enumerated and validated at build time (D25), so a miss means the caller is asking for
 * something nobody checked.
 */
export function findVariant(
  mode: BundledMode,
  parameters: Record<string, string | number>,
): BundledVariant | null {
  return (
    mode.variants.find((v) =>
      Object.entries(v.parameters).every(([k, value]) => parameters[k] === value),
    ) ?? null
  )
}

/** The variant a host gets if they touch nothing. */
export function defaultParameters(mode: BundledMode): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(mode.definition.parameters)) out[name] = spec.default
  return out
}

/**
 * Assembles the `Ruleset` that gets snapshotted into the creation event (§11 non-negotiable 2).
 *
 * `modeContentHash` comes from the bundle rather than being computed here — it was hashed over
 * the mode content *and* the resolved parameters at build time (D20/D25), and recomputing it in
 * a second place is how two truths start to disagree.
 */
export function rulesetFor(
  variant: BundledVariant,
  rosterVersion: string,
  globalBanned: string[],
): Ruleset {
  return {
    modeId: variant.mode.modeId,
    parameters: variant.parameters,
    rosterVersion,
    globalBanned,
    constraints: { crossSeatMirrors: 'ALLOWED', selfDuplicates: 'FORBIDDEN' },
    onTie: variant.mode.onTie,
    match: variant.mode.match,
    overtime: variant.mode.overtime,
    modeContentHash: variant.modeContentHash,
  }
}

/** D25 — `draftCount` is what §13's roster floor is keyed to. */
export function draftCountOf(variant: BundledVariant): number {
  const draft = variant.mode.program.find(
    (m) => m.type === 'SIMULTANEOUS_COMMIT' && m.commits.picks !== null,
  )
  return draft && draft.type === 'SIMULTANEOUS_COMMIT' && draft.commits.picks
    ? draft.commits.picks.count
    : 0
}
