/// <reference types="@cloudflare/workers-types" />

import type { CreateMatchResponse, Roster } from '@banpick/types'

import rosterAsset from '../../../roster/roster.json' with { type: 'json' }
import { generateRoomCode, isRoomCode, joinUrl, normalizeRoomCode } from './identity.js'
import { listModes } from './modes.js'

const ROSTER = rosterAsset as Roster

export { MatchDO } from './MatchDO.js'
export { PairHistoryDO } from './PairHistoryDO.js'
export { RegistryDO } from './RegistryDO.js'

/**
 * The Worker entry point: a router, and nothing more.
 *
 * All authority lives in the Durable Object (§11) — one per match, addressed by room code. This
 * layer resolves a code to a DO and forwards. It holds no state, makes no rules decisions, and
 * must not grow any: the moment legality is decided in two places, §7's redaction guarantee
 * becomes a promise rather than a property.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/api/modes') {
      // The lobby needs the mode list and its declared parameter space to render the host's
      // choices (§12.1). No match exists yet, so no DO is involved.
      return json(
        listModes().map((m) => ({
          modeId: m.modeId,
          label: m.definition.label,
          parameters: m.definition.parameters,
        })),
      )
    }

    if (path === '/api/roster') {
      // The host needs character *names* to choose a global ban list (§12.1), and that is a
      // lobby concern with no match attached — so it is served here rather than by conjuring a
      // Durable Object to ask. Display data only; §16 says the roster is public.
      return json({ rosterVersion: ROSTER.rosterVersion, characters: ROSTER.characters })
    }

    /*
     * D29 — the registry, one object for the deployment.
     *
     * Routed here rather than through a match DO because none of it belongs to a match: a name is
     * claimed before you have a room, and a leaderboard outlives every room on it.
     */
    if (
      path.startsWith('/api/player/') ||
      path === '/api/standings' ||
      path === '/api/head-to-head'
    ) {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
      const action = path === '/api/player/name' ? 'claim' : path.slice('/api/'.length)
      const target = new URL(`${url.origin}/${action}`)
      target.search = url.search
      return registry.fetch(new Request(target, request))
    }

    if (path === '/api/match' && request.method === 'POST') {
      return createMatch(request, env, url)
    }

    const match = /^\/api\/match\/([^/]+)\/(preview|seat|ws)$/.exec(path)
    if (match) {
      const [, rawCode, action] = match
      const roomCode = normalizeRoomCode(rawCode!)
      if (!isRoomCode(roomCode)) {
        return json({ error: 'BAD_ROOM_CODE', detail: 'not a room code' }, 400)
      }
      return stubFor(env, roomCode).fetch(rewrite(request, url, action!))
    }

    return json({ error: 'NOT_FOUND', detail: `no route for ${path}` }, 404)
  },
} satisfies ExportedHandler<Env>

/**
 * §12.1–12.2 — create, then hand back a code and a join URL that carries **the room code and
 * nothing else** (D20).
 *
 * The room code is generated here rather than in the DO because it *is* the DO's name: the code
 * has to exist before there is an object to ask for one.
 */
async function createMatch(request: Request, env: Env, url: URL): Promise<Response> {
  // Parsed here rather than in the DO because this is where the room code is merged in — and a
  // body that will not parse must fail as a 400 before a DO is ever addressed, not as an
  // unhandled throw halfway through allocating one.
  let body: object
  try {
    const parsed: unknown = JSON.parse(await request.text())
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed
  } catch {
    return json({ error: 'MALFORMED_BODY', detail: 'body must be a JSON object' }, 400)
  }

  // A collision would land on a match that already exists, which the DO rejects with 409. Six
  // characters from a 30-symbol alphabet is ~7×10^8 codes; at this scale retrying twice is
  // more than enough, and failing loudly beats silently joining strangers together.
  for (let attempt = 0; attempt < 3; attempt++) {
    const roomCode = generateRoomCode()
    const response = await stubFor(env, roomCode).fetch(
      new Request(`${url.origin}/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, roomCode }),
      }),
    )

    if (response.status === 409) continue // collision; try another code
    if (!response.ok) return response

    const created: CreateMatchResponse = {
      roomCode,
      joinUrl: joinUrl(url.origin, roomCode),
    }
    return json(created, 201)
  }

  return json({ error: 'ROOM_CODE_EXHAUSTED', detail: 'could not allocate a room code' }, 503)
}

/** One DO per match, named by room code (D8). */
function stubFor(env: Env, roomCode: string): DurableObjectStub {
  return env.MATCH.get(env.MATCH.idFromName(roomCode))
}

/** Forwards to the DO with the action as the path, preserving method, headers, and body. */
function rewrite(request: Request, url: URL, action: string): Request {
  const target = new URL(`${url.origin}/${action}`)
  target.search = url.search
  return new Request(target, request)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
