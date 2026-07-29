/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'

/**
 * Proves the harness itself: these tests run inside **workerd**, the runtime Cloudflare
 * deploys, not a Node emulation of it. That matters for everything else in this phase —
 * WebSocket hibernation, SQLite storage, and the single-threaded execution §11's concurrency
 * guarantee rests on all behave differently, or not at all, outside it.
 */
describe('the worker is alive', () => {
  it('serves the mode list without touching a Durable Object', () => {
    return SELF.fetch('https://example.com/api/modes')
      .then((r) => {
        expect(r.status).toBe(200)
        return r.json()
      })
      .then((modes) => {
        expect(modes).toHaveLength(2)
        expect((modes as { modeId: string }[]).map((m) => m.modeId).sort()).toEqual([
          'base',
          'bring-ban1',
        ])
      })
  })

  it('404s an unknown API route rather than falling through', async () => {
    const response = await SELF.fetch('https://example.com/api/nope')
    expect(response.status).toBe(404)
  })

  it('serves the roster for the lobby without conjuring a Durable Object', async () => {
    const response = await SELF.fetch('https://example.com/api/roster')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { characters: unknown[] }
    expect(body.characters.length).toBeGreaterThan(0)
  })
})

/**
 * **Static asset serving is not testable through this pool.**
 *
 * `@cloudflare/vitest-pool-workers` wires the `assets` *binding* but does not serve assets, so
 * `/`, `/j/ABC123`, and `/r/ABC123` all 404 here while working correctly under `wrangler dev`.
 * Asserting them would be asserting a false thing about the platform.
 *
 * Verified manually instead, against `wrangler dev` with the client built:
 *
 *   GET /            -> 200, the app
 *   GET /j/ABC123    -> 200, the app (SPA fallback; a shared join link has no file behind it)
 *   GET /api/modes   -> 200, JSON from the Worker (`run_worker_first` beats the asset handler)
 *
 * What *is* ours and is tested here: that API routes reach the Worker at all, which is the half
 * of the arrangement that could break from a code change rather than a config one.
 */
describe('API routes reach the Worker even with assets in front', () => {
  it('serves JSON on /api, not an asset', async () => {
    const response = await SELF.fetch('https://example.com/api/modes')
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})
