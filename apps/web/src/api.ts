import { currentPlayer } from './player.js'
import type {
  Character,
  ClaimSeatResponse,
  CreateMatchRequest,
  CreateMatchResponse,
  LobbyPreview,
} from '@banpick/types'

/** The lobby's HTTP surface. Everything after seating happens over the socket. */

export interface ModeSummary {
  modeId: string
  label: string
  parameters: Record<
    string,
    { values: (string | number)[]; default: string | number; label: string }
  >
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null
    throw new ApiError(response.status, body?.detail ?? `request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function listModes(): Promise<ModeSummary[]> {
  return fetch('/api/modes').then(json<ModeSummary[]>)
}

/** The character list, for naming a global ban. Display data — §16 makes the roster public. */
export function fetchRoster(): Promise<{ rosterVersion: string; characters: Character[] }> {
  return fetch('/api/roster').then(json<{ rosterVersion: string; characters: Character[] }>)
}

export function createMatch(request: CreateMatchRequest): Promise<CreateMatchResponse> {
  return fetch('/api/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }).then(json<CreateMatchResponse>)
}

/**
 * §12.3 — what a joiner is shown **before** seating.
 *
 * Fetched as its own step rather than folded into the seat claim, because seating is the
 * consent: the ruleset has to be on screen and readable before the button that accepts it
 * exists.
 */
export function fetchPreview(roomCode: string): Promise<LobbyPreview> {
  return fetch(`/api/match/${roomCode}/preview`).then(json<LobbyPreview>)
}

/**
 * D28/D29 — the claim carries who is sitting down, and the server requires it.
 *
 * It was optional when a name was decoration. It stopped being optional when a name became a
 * record: without one the match cannot reach the leaderboard and the no-repeat-ban rule has
 * nothing to key on, so the seat would play by quietly different rules. The lobby will not send
 * an empty name, and the server refuses one — `400 NAME_REQUIRED`.
 */
export function claimSeat(roomCode: string): Promise<ClaimSeatResponse> {
  const player = currentPlayer()
  return fetch(`/api/match/${roomCode}/seat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: player.id, displayName: player.name }),
  }).then(json<ClaimSeatResponse>)
}

// --- D29: names, standings, head-to-head ---------------------------------------------------

export interface Standing {
  playerId: string
  name: string
  wins: number
  losses: number
  draws: number
  roundWins: number
  roundLosses: number
  roundDraws: number
}

export interface MatchRecord {
  roomCode: string
  playedAt: number
  a: { id: string; name: string }
  b: { id: string; name: string }
  winnerId: string | null
  scoreA: number
  scoreB: number
  detail: {
    rounds: (string | null)[]
    seats: Record<'A' | 'B', { drafted: string[]; played: string[]; metaBan: string | null }>
  } | null
}

export interface HeadToHead {
  wins: number
  losses: number
  draws: number
  matches: MatchRecord[]
}

/**
 * Claims a name for this browser.
 *
 * Resolves to `null` on success, or the reason it failed. A rejection rather than a throw because
 * "somebody already has that name" is an ordinary answer the field should show, not an error.
 */
export async function claimName(playerId: string, displayName: string): Promise<string | null> {
  const response = await fetch('/api/player/name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, displayName }),
  })
  if (response.ok) return null
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  return body.error === 'NAME_TAKEN'
    ? 'Somebody here already uses that name.'
    : 'Could not save that name.'
}

export function fetchStandings(): Promise<{ standings: Standing[] }> {
  return fetch('/api/standings').then(json<{ standings: Standing[] }>)
}

export function fetchHeadToHead(a: string, b: string): Promise<HeadToHead> {
  return fetch(`/api/head-to-head?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`).then(
    json<HeadToHead>,
  )
}

// --- D31: the lobby list ---------------------------------------------------------------------

export interface RoomListing {
  roomCode: string
  modeLabel: string
  hostName: string
  seatsTaken: number
  status: 'OPEN' | 'PLAYING'
  openedAt: number
}

/**
 * Open and in-progress rooms on this deployment.
 *
 * Public, deliberately: the owner's call was that anyone who can reach the site can see the list
 * and join. The room code stops being a secret at that point — it was never much of one, but it
 * was something, and D31 records the trade rather than letting it happen quietly.
 */
export function fetchLobbies(): Promise<RoomListing[]> {
  return fetch('/api/lobbies')
    .then(json<{ rooms: RoomListing[] }>)
    .then((r) => r.rooms)
}

/**
 * D32 — opens (or finds) the rematch room for a finished match.
 *
 * Idempotent on the server, so both players pressing this lands them in the same room rather than
 * two rooms each waiting for the other. Returns the code; joining is still the ordinary lobby
 * flow, because §12.3 makes sitting down the act of consent and nobody else gets to do it for you.
 */
export function openRematch(roomCode: string, seatToken: string): Promise<string> {
  return fetch(`/api/match/${roomCode}/rematch?token=${encodeURIComponent(seatToken)}`, {
    method: 'POST',
  })
    .then(json<{ roomCode: string }>)
    .then((r) => r.roomCode)
}

// --- D34: history and the admin dashboard ------------------------------------------------------

export interface MatchDetail {
  rounds: (('A' | 'B' | 'TIE') | null)[]
  seats: Record<'A' | 'B', { drafted: string[]; played: string[]; metaBan: string | null }>
}

export interface Matchup {
  a: { id: string; name: string }
  b: { id: string; name: string }
  aWins: number
  bWins: number
  draws: number
  played: number
}

/** Every recorded match, newest first. Public and read-only. */
export function fetchMatches(): Promise<MatchRecord[]> {
  return fetch('/api/matches')
    .then(json<{ matches: MatchRecord[] }>)
    .then((r) => r.matches)
}

/** Pairwise records — one row per pairing, read from either side. */
export function fetchMatchups(): Promise<Matchup[]> {
  return fetch('/api/matchups')
    .then(json<{ matchups: Matchup[] }>)
    .then((r) => r.matchups)
}

/**
 * D34 — an admin correction to a stored match.
 *
 * The key travels in a header rather than the URL so it stays out of browser history and out of
 * any logging that records paths. Fields are optional and only what is sent is changed, which is
 * what stops a name correction from resetting a score.
 */
export function adminEditMatch(
  key: string,
  patch: {
    roomCode: string
    aName?: string
    bName?: string
    /** D35 — reassigning one match to a different player. The winner follows the seat. */
    aId?: string
    bId?: string
    winnerId?: string | null
    scoreA?: number
    scoreB?: number
    rounds?: (('A' | 'B' | 'TIE') | null)[]
  },
): Promise<MatchRecord> {
  return fetch('/api/admin/edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(patch),
  })
    .then(json<{ match: MatchRecord }>)
    .then((r) => r.match)
}

export function adminDeleteMatch(key: string, roomCode: string): Promise<void> {
  return fetch('/api/admin/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ roomCode }),
  }).then(json<{ ok: true }>) as unknown as Promise<void>
}

// --- D35: the player directory ------------------------------------------------------------------

export interface PlayerSummary {
  playerId: string
  name: string
  claimedNames: string[]
  played: number
  wins: number
  losses: number
  draws: number
  firstPlayedAt: number
  lastPlayedAt: number
}

/**
 * Every id this deployment has seen.
 *
 * Behind the admin key, though it is worth being precise about what that does and does not buy:
 * `/api/matches` is public and every row on it already carries both players' ids, so this is not
 * the thing keeping them secret — nothing is. What the key adds is the ids that have *never*
 * played (a claimed name and nothing else), and a list of them sitting beside the endpoints that
 * rewrite history is admin furniture either way.
 *
 * Falls back to an empty list rather than propagating a shape it did not expect: this feeds a
 * `.map`, and a dashboard that blanks out is a worse answer to a malformed response than a
 * dashboard that says nobody is listed.
 */
export function adminFetchPlayers(key: string): Promise<PlayerSummary[]> {
  return fetch('/api/admin/players', { headers: { 'x-admin-key': key } })
    .then(json<{ players: PlayerSummary[] }>)
    .then((r) => r.players ?? [])
}

/**
 * D35 — folds one id's history into another's.
 *
 * Returns the refreshed directory rather than `void`, because a merge changes every row it
 * touches and the screen that asked for it needs all of them: re-reading is a second round trip
 * to learn what this request already knows.
 */
export function adminMergePlayers(
  key: string,
  merge: { fromId: string; intoId: string; name?: string },
): Promise<{ moved: number; names: number; players: PlayerSummary[] }> {
  return fetch('/api/admin/merge', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(merge),
  }).then(json<{ moved: number; names: number; players: PlayerSummary[] }>)
}
