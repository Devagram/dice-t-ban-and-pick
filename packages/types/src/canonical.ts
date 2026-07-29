/**
 * Deterministic serialization.
 *
 * Three things need it and they must all agree, which is why it lives here rather than in any
 * one of them:
 *
 *   - Phase 1's determinism gate — the same event list replayed 100× must produce an
 *     identical state, and "identical" needs a definition that does not depend on key order.
 *   - Phase 2's `modeContentHash` (D20) — hashed over this, not over `JSON.stringify`.
 *   - Phase 5's export/replay gate — a re-imported match must reach an identical terminal
 *     state, which is the test that proves event sourcing was implemented rather than intended.
 *
 * Hashing itself is deliberately **not** here: SHA-256 means `crypto.subtle`, and the engine's
 * no-IO lint bans `crypto` outright. The Durable Object and the loader hash the string this
 * produces.
 */

/**
 * JSON with object keys sorted recursively and no insignificant whitespace.
 *
 * Array order is preserved — it is meaningful everywhere in this design (slots are an ordered
 * array precisely so they are addressable ban targets, spec §5). Callers that want an
 * order-insensitive hash of a *set*, such as `globalBanned`, sort it before passing it in.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value)
}

function stringify(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'number':
      // Infinity and NaN have no JSON form. Failing loudly beats writing `null` into a hash.
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number (${String(value)})`)
      }
      return JSON.stringify(value)
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'bigint':
      throw new TypeError('canonicalJson: bigint has no canonical JSON form')
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: ${typeof value} is not serializable`)
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => stringify(v === undefined ? null : v)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` members are omitted, matching JSON.stringify — and matching the redaction
    // shape in view.ts, where a hidden field is absent rather than present-and-empty.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v)}`).join(',')}}`
}
