/**
 * Load failures are **values with stable codes**, not thrown strings.
 *
 * The delivery plan asks for "one intentionally malformed mode per validator, each failing with
 * a distinct stable error code", and the reason those codes have to be stable is the same one
 * that makes the loader worth building at all: a mode that cannot work should fail at deploy,
 * naming the rule it broke, rather than at 1.5–1.5 in front of two players.
 */
export type LoadErrorCode =
  /** The file is not YAML, or not a mapping. */
  | 'YAML_PARSE'
  /** The file does not match `schema/mode.schema.json`. */
  | 'SCHEMA_INVALID'
  /** The file declares a `schemaVersion` this loader does not implement. */
  | 'SCHEMA_VERSION'
  /** Two modules in one program share an id, so `remove` would be ambiguous. */
  | 'DUPLICATE_MODULE_ID'
  /** §13 — a module reads a slice no upstream module writes. */
  | 'SLICE_DEPENDENCY'
  /** §13 — `|activeRoster| - |globalBans| < draftCount + 1`. */
  | 'ROSTER_VIABILITY'
  /** §13 — a slice is sealed with a `revealedBy` tag no module ever emits. */
  | 'REVEAL_UNREACHABLE'
  /** §13 — `remove` deleted a module the round cannot complete without. */
  | 'TRANSITION_REMOVED'
  /** §13/D25 — the declared parameter space exceeds the cap, or a value is not declared. */
  | 'PARAMETER_SPACE'
  /** §13/G14 — the (scoring, resolution, overtime) triple is not provably terminating. */
  | 'NON_TERMINATING'
  /** The mode is structurally sound but does not resolve — e.g. an override names nothing. */
  | 'RESOLUTION_FAILED'

export interface LoadIssue {
  code: LoadErrorCode
  /** Which mode, and where inside it. */
  path: string
  message: string
}

export class ModeLoadError extends Error {
  readonly issues: LoadIssue[]

  constructor(modeRef: string, issues: LoadIssue[]) {
    const lines = issues.map((i) => `  [${i.code}] ${i.path}: ${i.message}`)
    super(`${modeRef} failed to load:\n${lines.join('\n')}`)
    this.name = 'ModeLoadError'
    this.issues = issues
  }

  /** The codes, in order. What a failure fixture asserts on. */
  get codes(): LoadErrorCode[] {
    return this.issues.map((i) => i.code)
  }

  has(code: LoadErrorCode): boolean {
    return this.issues.some((i) => i.code === code)
  }
}

export function issue(code: LoadErrorCode, path: string, message: string): LoadIssue {
  return { code, path, message }
}
