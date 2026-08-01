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
 * D28 — the claim carries who is sitting down.
 *
 * Optional on the server, so an older client still seats fine; sending it is what makes the
 * no-repeat-ban rule able to find a history.
 */
export function claimSeat(roomCode: string): Promise<ClaimSeatResponse> {
  const player = currentPlayer()
  return fetch(`/api/match/${roomCode}/seat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: player.id, displayName: player.name }),
  }).then(json<ClaimSeatResponse>)
}
