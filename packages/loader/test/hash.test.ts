import { describe, expect, it } from 'vitest'
import { canonicalRuleset, rulesetHash, sha256Hex, variantFor } from '@banpick/loader'
import type { Ruleset } from '@banpick/types'

import { loadShipped, GAME_ROSTER } from './helpers.js'

/**
 * D20 — `modeContentHash`, and the canonical serialization it rests on.
 *
 * The exit criteria: a golden hash is pinned; changing `label` does not move it; changing
 * `globalBanned` order does not move it; changing `rosterVersion` does. Between them those
 * four say the hash tracks *meaning* rather than *text*, which is the only version of it worth
 * writing into every creation event.
 */

describe('SHA-256, against the published vectors', () => {
  // FIPS 180-4. The hash goes into every creation event forever, so it is checked against
  // something external rather than against itself.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('hashes %j correctly', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })

  it('handles multi-byte UTF-8, which the mode labels contain', () => {
    // "Standard Bo3 — draft 4" has an em dash (U+2014, three bytes). A hash that mangled it
    // would still be stable, and stable-but-wrong is the failure mode nothing else surfaces.
    // Cross-checked against node:crypto rather than against itself.
    expect(sha256Hex('—')).toBe('bda050585a00f0f6cb502350559d75532ae3b244c9498b996e7c5df2d98dfc8d')
  })

  it('handles a surrogate pair, which the hand-rolled UTF-8 encoder has to reassemble', () => {
    expect(sha256Hex('🎲')).toBe('e94e8b04547b50aa5904e44b17189c348ad0a8929803725b136ac3548a194ef6')
  })

  it('spans a block boundary correctly', () => {
    // 64 bytes is exactly one block, so padding spills into a second one.
    expect(sha256Hex('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
  })
})

describe('modeContentHash (D20)', () => {
  it('differs between parameter values of the same file', () => {
    // "The same mode at draftCount 3 and draftCount 4 is two different rulesets and must hash
    // differently." Without this, editing the parameter would silently reuse a snapshot.
    const loaded = loadShipped('base')
    const three = variantFor(loaded, { draftCount: 3 }).modeContentHash
    const four = variantFor(loaded, { draftCount: 4 }).modeContentHash
    expect(three).not.toBe(four)
  })

  it('differs between modes', () => {
    const base = variantFor(loadShipped('base'), { draftCount: 4 }).modeContentHash
    const bring = variantFor(loadShipped('bring-ban1'), { draftCount: 4 }).modeContentHash
    expect(base).not.toBe(bring)
  })

  it('is stable across loads — the same file always hashes the same', () => {
    const a = variantFor(loadShipped('base'), { draftCount: 4 }).modeContentHash
    const b = variantFor(loadShipped('base'), { draftCount: 4 }).modeContentHash
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('does not move when only display copy changes', () => {
    // `label` is display copy. Rewording "Standard Bo3" must not make a mode a different mode —
    // the same instinct as D14's "IDs are identity, names are not".
    const original = variantFor(loadShipped('base'), { draftCount: 4 })
    const renamed = variantFor(loadModeWithLabel('Best of three, but friendlier'), {
      draftCount: 4,
    })
    expect(renamed.modeContentHash).toBe(original.modeContentHash)
    expect(renamed.mode.label).not.toBe(original.mode.label)
  })

  it('does move when a rule changes', () => {
    // This is the risk D20 was repurposed to guard: you can change the tie rule inside
    // `base.yaml` and `modeId` never moves, so a replay would apply different rules silently.
    const original = variantFor(loadShipped('base'), { draftCount: 4 }).modeContentHash
    const changed = variantFor(loadModeWith('stopWhenDecided: true', 'stopWhenDecided: false'), {
      draftCount: 4,
    }).modeContentHash
    expect(changed).not.toBe(original)
  })
})

describe('canonical ruleset serialization', () => {
  /**
   * Every field is a literal, including `rosterVersion` and the ban ids.
   *
   * A golden hash pinned against live game data is not a golden hash — adding a character to
   * the roster would "fail" this test for a reason that has nothing to do with serialization,
   * and the only available fix would be to re-pin, which is how a golden test quietly stops
   * meaning anything. The ids below are deliberately not real characters.
   */
  const ruleset = (over: Partial<Ruleset> = {}): Ruleset => ({
    modeId: 'base',
    parameters: { draftCount: 4 },
    rosterVersion: '2026.07.28-1',
    globalBanned: ['oracle', 'anvil', 'vagrant'],
    constraints: {
      crossSeatMirrors: 'ALLOWED',
      selfDuplicates: 'FORBIDDEN',
      repeatBans: 'FORBIDDEN',
    },
    onTie: { scoring: 'HALF_POINT', consumesCharacters: true },
    match: { resolution: 'ALWAYS_3_ROUNDS', stopWhenDecided: true },
    overtime: { enabled: false },
    resultReporting: 'ONE_SIDED',
    modeContentHash: 'abc123def456',
    ...over,
  })

  it('pins a golden hash', () => {
    // Pinned deliberately. If this value changes, the canonical serialization changed, and
    // every hash written by an earlier build has silently stopped matching. The assertion on
    // the canonical string as well as the digest is so a failure says *what* moved rather than
    // just that something did.
    //
    // **Moved once, on 2026-08-01**, when D28 added `repeatBans` to the constraints — the ruleset
    // genuinely gained a field, so the hash genuinely changed. Rulesets written before that date
    // hash differently, which is correct: they described a different set of rules. This is what
    // the assertion is for, and updating it is a decision rather than a chore.
    //
    // **Moved again on 2026-08-15**, when D38 added `resultReporting`. Same situation and the
    // same verdict: a match that requires both seats to confirm a result is playing under
    // different rules from one that does not, and it should not hash the same. Every ruleset
    // written before today carried an implicit `ONE_SIDED`, so the pre-D38 digest describes the
    // same rules under a shorter name — but the serialization is what this pins, and it moved.
    expect(canonicalRuleset(ruleset())).toBe(
      '{"constraints":{"crossSeatMirrors":"ALLOWED","repeatBans":"FORBIDDEN",' +
        '"selfDuplicates":"FORBIDDEN"},' +
        '"globalBanned":["anvil","oracle","vagrant"],' +
        '"match":{"resolution":"ALWAYS_3_ROUNDS","stopWhenDecided":true},' +
        '"modeContentHash":"abc123def456","modeId":"base",' +
        '"onTie":{"consumesCharacters":true,"scoring":"HALF_POINT"},' +
        '"overtime":{"enabled":false},"parameters":{"draftCount":4},' +
        '"resultReporting":"ONE_SIDED",' +
        '"rosterVersion":"2026.07.28-1"}',
    )
    expect(rulesetHash(ruleset())).toBe('d36ed8e6f37a')
  })

  it('is insensitive to globalBanned order', () => {
    // A ban list is a *set*; its YAML order carries no meaning. Arrays are order-significant
    // everywhere else in this design (slots are ordered precisely so they are addressable ban
    // targets, §5), which is why the sort lives here rather than inside `canonicalJson`.
    expect(rulesetHash(ruleset({ globalBanned: ['anvil', 'oracle', 'vagrant'] }))).toBe(
      rulesetHash(ruleset({ globalBanned: ['vagrant', 'anvil', 'oracle'] })),
    )
  })

  it('is insensitive to key order', () => {
    const forwards = ruleset()
    const backwards = Object.fromEntries(Object.entries(forwards).reverse()) as Ruleset
    expect(canonicalRuleset(backwards)).toBe(canonicalRuleset(forwards))
  })

  it('changes when rosterVersion changes', () => {
    // The draftable set is part of what a match was played against (§16 rule 3), so a bump
    // must be visible.
    expect(rulesetHash(ruleset({ rosterVersion: '2099.01.01-1' }))).not.toBe(rulesetHash(ruleset()))
  })

  it('changes when the ban list changes, not merely when it is reordered', () => {
    expect(rulesetHash(ruleset({ globalBanned: ['oracle', 'anvil'] }))).not.toBe(
      rulesetHash(ruleset()),
    )
  })

  it('changes when a parameter changes', () => {
    expect(rulesetHash(ruleset({ parameters: { draftCount: 3 } }))).not.toBe(rulesetHash(ruleset()))
  })
})

// --- fixtures ------------------------------------------------------------------------------

import { loadModeFromSource } from '@banpick/loader'
import { modeSource } from './helpers.js'

function loadModeWith(find: string, replace: string) {
  const source = modeSource('base')
  if (!source.includes(find)) {
    throw new Error(`hash fixture: '${find}' is not in modes/base.yaml — it has drifted`)
  }
  return loadModeFromSource(source.replace(find, replace), 'base', { roster: GAME_ROSTER })
}

/**
 * Replaces the label's *text* rather than the whole `label:` line, so the fixture survives
 * Prettier deciding the YAML wants single quotes instead of double.
 */
function loadModeWithLabel(label: string) {
  return loadModeWith('Standard Bo3 — draft ${draftCount}', label)
}
