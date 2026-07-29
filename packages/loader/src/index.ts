/**
 * `@banpick/loader` — mode YAML in, validated and hashed modes out.
 *
 * This package is where §1's central bet gets settled: *"New modes must be config, never engine
 * code."* Phase 1 built both shipped modes programmatically; this phase reads the same modes
 * from `modes/*.yaml` and the acceptance test is that the two are deep-equal. If they were not,
 * the module boundary would be wrong and that would be a spec finding, not a patch.
 *
 * It runs at **build time**, in the same trust domain as the Durable Object, and it is the only
 * way to obtain a `ResolvedMode` from a file — which is what makes "no mode file can reach the
 * engine without passing validation" a property rather than a convention. It is never shipped
 * to a client (D18).
 */

export {
  loadModeFromSource,
  variantFor,
  defaultVariant,
  type LoadedMode,
  type LoadedVariant,
  type LoadOptions,
} from './loadMode.js'

export { ModeLoadError, type LoadErrorCode, type LoadIssue } from './errors.js'
export { SCHEMA_VERSION, parseMode } from './parse.js'
export { modeContentHash, canonicalRuleset, rulesetHash, digest12 } from './hash.js'
export { sha256Hex } from './sha256.js'
export {
  PARAMETER_SPACE_CAP,
  parameterCombinations,
  validateRevealReachability,
  validateRosterViability,
  validateSliceDependency,
  validateTermination,
  validateTransitionPreservation,
  validateUniqueIds,
} from './validators.js'
