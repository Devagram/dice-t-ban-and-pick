import { canonicalJson, type Ruleset } from '@banpick/types'

import { sha256Hex } from './sha256.js'

/**
 * D20 — `modeContentHash`.
 *
 * The spec's first instinct was a hash in the join URL, guarding against a joiner rendering the
 * ruleset preview from its own bundled mode files. §11.4's thin-client rule already forbids
 * that, and every duplicated guarantee is a place two truths can disagree — so D20 cut it and
 * repurposed the same twenty lines to guard something genuinely unguarded: **you can change the
 * tie rule inside `base.yaml` and `modeId` never moves.** A replay would then apply different
 * rules and say nothing.
 *
 * So the hash covers the resolved mode definition content *and* the resolved parameters (D25).
 * The same file at `draftCount` 3 and 4 is two different rulesets and must hash differently.
 */

/** SHA-256, first 12 hex characters. Short enough to eyeball in a log, long enough to mean it. */
export function digest12(input: string): string {
  return sha256Hex(input).slice(0, 12)
}

/**
 * Hashed over the canonical form, with `label` excluded.
 *
 * `label` is display copy. Rewording "Standard Bo3" must not make a mode a different mode —
 * that is the same instinct as D14's "IDs are identity, names are not".
 */
export function modeContentHash(
  modeId: string,
  content: unknown,
  parameters: Record<string, string | number>,
): string {
  return digest12(
    canonicalJson({
      modeId,
      content: stripLabels(content),
      parameters,
    }),
  )
}

/**
 * Canonical serialization of a `Ruleset` for comparison and logging.
 *
 * Sorted keys come from `canonicalJson`; `globalBanned` is sorted here because it is a **set**
 * whose YAML order carries no meaning. Arrays are order-significant everywhere else in this
 * design (slots are an ordered array precisely so they are addressable ban targets, §5), which
 * is why the sort is applied at the one place it belongs rather than inside the serializer.
 */
export function canonicalRuleset(ruleset: Ruleset): string {
  return canonicalJson({
    ...ruleset,
    globalBanned: [...ruleset.globalBanned].sort(),
  })
}

export function rulesetHash(ruleset: Ruleset): string {
  return digest12(canonicalRuleset(ruleset))
}

function stripLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLabels)
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'label') continue
    out[k] = stripLabels(v)
  }
  return out
}
