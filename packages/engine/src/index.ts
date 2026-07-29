/**
 * `@banpick/engine` — the rules.
 *
 * Pure, total, zero IO. Imported by the Durable Object and **never** by the client (D18): §11
 * says the client renders `legalActions()` and never computes legality, and not shipping it the
 * code that could is what makes that a property rather than a promise. `scripts/check-boundaries.mjs`
 * fails the build if this package escapes.
 *
 * The three functions of spec §5 are `reduce`, `legalActions`, and `project`. `systemStep` is
 * the fourth that D26 made necessary — see its file for why it is not folded into `reduce`.
 */

export { reduce, isDecided, matchOutcome } from './reduce.js'
export { legalActions } from './legalActions.js'
export { project } from './project.js'
export { systemStep, settle } from './systemStep.js'

export {
  resolveMode,
  revealTag,
  ModeResolutionError,
  type ResolutionErrorCode,
} from './resolveMode.js'
export { createMatch, ENGINE_VERSION, majorOf } from './createMatch.js'

export { rollDie, rollDice, type RollKey } from './rng.js'
export * from './pools.js'
export { MODES, baseMode, bringBan1Mode } from './modes/index.js'
export { moduleFor, REGISTRY } from './modules/index.js'
export type { PhaseModule, ModuleCtx, ApplyResult } from './context.js'
