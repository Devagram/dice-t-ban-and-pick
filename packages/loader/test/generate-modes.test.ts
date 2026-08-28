import { describe, expect, it } from 'vitest'
import { canonicalJson } from '@banpick/types'

import { loadShipped, shippedModeIds, GAME_ROSTER } from './helpers.js'

/**
 * Generates the worker's bundled modes, and fails if they have drifted.
 *
 * **Why the worker gets JSON rather than the YAML.** Validation is a build-time concern by
 * design — the loader is the only thing that parses a mode file, and §13's whole argument is
 * that a bad mode should fail at deploy rather than mid-match. But there is also a hard
 * constraint: the schema validator compiles with `new Function`, and Workers forbid that. So
 * the loader cannot run inside the Durable Object even if we wanted it to.
 *
 * The output is therefore plain data: already parsed, already validated, already hashed. The
 * worker imports it and cannot obtain a mode any other way.
 *
 * This is a **file snapshot**, so `vitest -u` regenerates it and a plain run fails if a YAML
 * edit was not carried through. Editing `modes/*.yaml` without regenerating is exactly the
 * drift this catches.
 */

/*
 * Read off the directory rather than listed here. A hardcoded array made adding a mode a
 * two-place change, and the second place was invisible: the new file loaded and validated
 * perfectly and simply never reached the worker.
 */
const MODE_IDS = shippedModeIds()

/** What each mode's parameter space should enumerate — D25's claim, mode by mode. */
const EXPECTED_VARIANTS: Record<string, Record<string, string | number>[]> = {
  base: [{ draftCount: 3 }, { draftCount: 4 }],
  'bring-ban1': [{ draftCount: 3 }, { draftCount: 4 }],
  // D36 — no parameters, so exactly one variant. Three brought is the format here rather than a
  // setting; at two there is nothing to ban and at four the ban stops mattering.
  'bo1-bring3-ban1': [{}],
  // D52 — one pick each, so there is nothing left to parameterise: at two this would be a
  // different game with a selection decision in it.
  'bo1-pick1': [{}],
}

describe('generated worker modes', () => {
  it('are current with modes/*.yaml', async () => {
    const bundle: Record<string, unknown> = {}
    for (const id of MODE_IDS) bundle[id] = loadShipped(id)

    const source = JSON.stringify(
      {
        $comment:
          'GENERATED — do not edit. Produced by packages/loader/test/generate-modes.test.ts ' +
          'from modes/*.yaml. Regenerate with `npm run build:modes`. Every mode here has ' +
          'passed all six §13 validators at every declared parameter combination (D25).',
        rosterVersion: GAME_ROSTER.rosterVersion,
        modes: bundle,
      },
      null,
      2,
    )

    await expect(`${source}\n`).toMatchFileSnapshot('../../../apps/worker/src/generated/modes.json')
  })

  it('bundles every declared parameter combination, not just the defaults', () => {
    // The worker offers a lobby choice per variant, so a missing one is a combination a host
    // could pick that was never validated.
    for (const id of MODE_IDS) {
      const expected = EXPECTED_VARIANTS[id]
      // A new mode with no entry above is a mode nobody stated the parameter space of, which is
      // the thing this test exists to check. Failing is the point.
      expect(expected, `no expected variants declared for '${id}'`).toBeDefined()
      expect(loadShipped(id).variants.map((v) => v.parameters)).toEqual(expected)
    }
  })

  it('is deterministic — regenerating produces an identical bundle', () => {
    // Otherwise the snapshot would churn on every run and stop meaning anything.
    expect(canonicalJson(loadShipped('base'))).toBe(canonicalJson(loadShipped('base')))
  })
})
