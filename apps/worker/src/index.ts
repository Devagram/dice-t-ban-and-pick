/// <reference types="@cloudflare/workers-types" />

import type { CreateMatchResponse, Roster } from '@banpick/types'

import rosterAsset from '../../../roster/roster.json' with { type: 'json' }
import {
  generateRoomCode,
  generateTournamentCode,
  isRoomCode,
  isTournamentCode,
  joinUrl,
  normalizeRoomCode,
  normalizeTournamentCode,
  tournamentUrl,
} from './identity.js'
import { listModes } from './modes.js'

const ROSTER = rosterAsset as Roster

/**
 * The admin surface, listed rather than pattern-matched.
 *
 * An allowlist because the alternative — forwarding anything under `/api/admin/` — would expose
 * every action the registry has the moment one is added for another caller, and the whole point
 * of this branch is that it is the only door to `edit`, `delete`, and now D35's `players` and
 * `merge`.
 *
 * `players` is a read, and it is here rather than beside the public ones for two reasons: it
 * lists ids that have never played, which no public response carries, and it is the inventory
 * `merge` operates on. It is **not** what keeps a player id private — `/api/matches` is public
 * and every row on it names both ids. That is a property of D19's no-accounts model rather than
 * an oversight here, but it is the reason this comment does not claim otherwise.
 */
const ADMIN_ACTIONS = new Set(['edit', 'delete', 'players', 'merge'])

export { MatchDO } from './MatchDO.js'
export { PairHistoryDO } from './PairHistoryDO.js'
export { RegistryDO } from './RegistryDO.js'
export { TournamentDO } from './TournamentDO.js'

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
     * D34 — the admin routes, behind a shared key.
     *
     * **Fails closed.** A deployment that never ran `wrangler secret put ADMIN_KEY` has no admin,
     * rather than an admin anyone can be. The lobby being open to everyone (D31) was a decision
     * about who may *join a game*; letting the same crowd rewrite every recorded result is a
     * different power and gets a different answer.
     *
     * Checked here rather than in the Durable Object so there is one door: the DO's `edit` and
     * `delete` are unreachable except through this branch.
     */
    if (path.startsWith('/api/admin/')) {
      if (!env.ADMIN_KEY) {
        return json({ error: 'ADMIN_DISABLED', detail: 'no ADMIN_KEY is configured' }, 503)
      }
      const offered = request.headers.get('x-admin-key') ?? ''
      if (!constantTimeEquals(offered, env.ADMIN_KEY)) {
        return json({ error: 'UNAUTHORIZED', detail: 'bad or missing admin key' }, 401)
      }
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
      const action = path.slice('/api/admin/'.length)
      if (!ADMIN_ACTIONS.has(action)) {
        return json({ error: 'NOT_FOUND', detail: `no admin route for ${path}` }, 404)
      }
      return registry.fetch(new Request(`${url.origin}/${action}`, request))
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
      path === '/api/head-to-head' ||
      // D31 — the open-room list. Same reasoning as the rest: it belongs to the deployment, not
      // to any one match, so it never touches a MatchDO.
      path === '/api/lobbies' ||
      // D34 — the history page's two reads. Public and read-only: these are the same rows the
      // standings are already derived from, shown rather than summarised.
      path === '/api/matches' ||
      path === '/api/matchups' ||
      // D37 Phase 8 — the tournament index. Public, and served from the registry rather than from
      // any tournament object, because those are swept after a week and this list is not.
      path === '/api/tournaments'
    ) {
      const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
      const action =
        path === '/api/player/name'
          ? 'claim'
          : path === '/api/lobbies'
            ? 'rooms'
            : path.slice('/api/'.length)
      const target = new URL(`${url.origin}/${action}`)
      target.search = url.search
      return registry.fetch(new Request(target, request))
    }

    if (path === '/api/match' && request.method === 'POST') {
      return createMatch(request, env, url)
    }

    // D37 — tournaments. Created by an organizer, read by anybody: a bracket is public for the
    // same reason D31's lobby list and D34's history are, and most people looking at one are
    // spectators rather than entrants.
    if (path === '/api/tournament' && request.method === 'POST') {
      return createTournament(request, env, url)
    }

    const tournament =
      /^\/api\/tournament\/([^/]+)(?:\/(relink|provision|ws|resolve|voidSlot|correct|cascade|reseed|entrants))?$/.exec(
        path,
      )
    if (tournament) {
      const code = normalizeTournamentCode(tournament[1]!)
      if (!isTournamentCode(code)) {
        return json({ error: 'BAD_TOURNAMENT_CODE', detail: 'not a tournament code' }, 400)
      }
      /*
       * **Every mutation here is gated by the organizer token** (Phase 7), checked inside the
       * Durable Object against an allowlist rather than route by route — see `ORGANIZER_ACTIONS`.
       * The gate lives there because that is where the token is stored, and a second check out
       * here would be a second place for the two to disagree.
       *
       * `view`, `cascade` and `ws` are deliberately open. The first two only read, and the bracket
       * they describe is public; the socket is read-only and most people watching a bracket are
       * not playing in it.
       */
      const action = tournament[2] ?? 'view'
      const response = await tournamentStub(env, code).fetch(
        new Request(`${url.origin}/${action}`, request),
      )

      /*
       * D37 Phase 8 — a finished tournament keeps its page after its object is swept.
       *
       * D42 deletes a tournament's storage seven days after its last activity, and a week later is
       * usually exactly when somebody follows a link from the history to see who won. So a 404 on
       * a read falls through to the registry's archived bracket, which was filed the moment the
       * tournament finished. Only for the plain read: a mutation against a swept tournament is
       * genuinely gone and should say so rather than appear to half-work.
       */
      if (response.status === 404 && action === 'view') {
        const archived = await archivedTournament(env, code)
        if (archived) return json({ ...archived, archived: true })
      }
      return response
    }

    const match = /^\/api\/match\/([^/]+)\/(preview|seat|ws|rematch)$/.exec(path)
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

  /*
   * D37 — a tournament binding cannot be asked for from out here.
   *
   * It turns off open seating (D41) and keeps the room out of the lobby list (D31), so a client
   * that could set one could mint itself a private room claiming to belong to somebody's event.
   * `TournamentDO` addresses the match object directly and is the only caller that may attach one.
   * Refused loudly rather than stripped: silently ignoring a field somebody sent is how they end
   * up debugging why their tournament match behaves like a casual one.
   */
  if ('tournament' in body) {
    return json(
      { error: 'TOURNAMENT_BINDING_REFUSED', detail: 'only a tournament can open its own matches' },
      400,
    )
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

/**
 * D37 — create a tournament, and hand back the code plus one entrant token per entrant.
 *
 * The tokens are returned **once**, here, and never again: only their hashes are stored, exactly
 * as D17 treats a seat token. That is what makes D41's "the organizer can re-mint one" the
 * recovery path rather than a convenience, and it is why this response is the only place they
 * exist in the clear.
 *
 * Shaped like `createMatch` deliberately, including the collision retry — the code is the DO's
 * name, so it has to exist before there is an object to ask for one.
 */
async function createTournament(request: Request, env: Env, url: URL): Promise<Response> {
  let body: object
  try {
    const parsed: unknown = JSON.parse(await request.text())
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    body = parsed
  } catch {
    return json({ error: 'MALFORMED_BODY', detail: 'body must be a JSON object' }, 400)
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateTournamentCode()
    const response = await tournamentStub(env, code).fetch(
      new Request(`${url.origin}/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, code }),
      }),
    )

    if (response.status === 409) continue // collision; try another code
    if (!response.ok) return response

    const created = (await response.json()) as {
      organizerToken: string
      entrants: { entrantId: string; displayName: string; seed: number; entrantToken: string }[]
    }
    return json(
      {
        code,
        url: tournamentUrl(url.origin, code),
        /*
         * Returned once, here, and never again — only its hash is stored. Whoever creates the
         * tournament is its organizer, and if they lose this there is no recovery: the tournament
         * simply has no organizer from then on, which is the fail-closed reading and the same one
         * `ADMIN_KEY` gets.
         */
        organizerToken: created.organizerToken,
        entrants: created.entrants.map((e) => ({
          ...e,
          // D41 — the token rides in the fragment, so it never reaches a server log or a proxy.
          url: tournamentUrl(url.origin, code, e.entrantToken),
        })),
      },
      201,
    )
  }

  return json({ error: 'CODE_EXHAUSTED', detail: 'could not allocate a tournament code' }, 503)
}

/** One DO per match, named by room code (D8). */
function stubFor(env: Env, roomCode: string): DurableObjectStub {
  return env.MATCH.get(env.MATCH.idFromName(roomCode))
}

/**
 * The archived final bracket of a tournament whose own object is gone, or `null`.
 *
 * `null` covers both "never existed" and "still running": the registry only holds a bracket for a
 * finished tournament, so a running one that 404s here is a code nobody has heard of either way.
 */
async function archivedTournament(env: Env, code: string): Promise<object | null> {
  const response = await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).fetch(
    `https://registry/archive?code=${encodeURIComponent(code)}`,
  )
  if (!response.ok) return null
  const body = (await response.json()) as { view?: object }
  return body.view ?? null
}

/** One DO per tournament, named by its code (D37). */
function tournamentStub(env: Env, code: string): DurableObjectStub {
  return env.TOURNAMENT.get(env.TOURNAMENT.idFromName(code))
}

/** Forwards to the DO with the action as the path, preserving method, headers, and body. */
function rewrite(request: Request, url: URL, action: string): Request {
  const target = new URL(`${url.origin}/${action}`)
  target.search = url.search
  return new Request(target, request)
}

/**
 * Compares without leaking the answer in how long it took.
 *
 * At this scale a timing attack on a shared key is close to theoretical — but the mitigation is
 * six lines and the alternative is explaining why it was skipped. Lengths are compared first and
 * that difference *is* observable; a length oracle on a secret nobody is enumerating is a trade
 * worth making for code this simple.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
