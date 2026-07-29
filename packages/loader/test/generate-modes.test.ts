import { describe, expect, it } from 'vitest'
import { canonicalJson } from '@banpick/types'

import { loadShipped, ROSTER_10 } from './helpers.js'

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

const MODE_IDS = ['base', 'bring-ban1'] as const

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
        rosterVersion: ROSTER_10.rosterVersion,
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
      expect(loadShipped(id).variants.map((v) => v.parameters)).toEqual([
        { draftCount: 3 },
        { draftCount: 4 },
      ])
    }
  })

  it('is deterministic — regenerating produces an identical bundle', () => {
    // Otherwise the snapshot would churn on every run and stop meaning anything.
    expect(canonicalJson(loadShipped('base'))).toBe(canonicalJson(loadShipped('base')))
  })
})
