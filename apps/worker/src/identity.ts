/// <reference types="@cloudflare/workers-types" />

/**
 * Room codes, seat tokens — and since D37, tournament codes and entrant tokens.
 *
 * This file used to open by saying room code plus seat token was the entire identity model
 * "permanently rather than provisionally, because there is no tournament layer coming". There is
 * one coming. What D19 actually got right survives intact and is worth stating instead: **no
 * accounts, no passwords, and nothing that crosses devices except a link.** D41's entrant token
 * is another bearer credential minted the same way and carried the same way, not the beginning of
 * a login.
 */

/**
 * Crockford base32 minus the letters that get misread aloud or mistyped.
 *
 * Room codes get read across a table — "was that an oh or a zero" is the failure mode, and it
 * costs nothing to make impossible.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const ROOM_CODE_LENGTH = 6

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return code
}

/** Room codes are case-insensitive to type; they are stored and compared uppercase. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase()
}

export function isRoomCode(input: string): boolean {
  const code = normalizeRoomCode(input)
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c))
}

/**
 * D17 — the sole credential for a seat, minted at `SEAT_FILLED` and returned once.
 *
 * 256 bits from the platform CSPRNG. It is a bearer credential and it is embedded in a resume
 * link, so it will end up in browser history and possibly a chat message; the casual-play trust
 * model (D19) accepts that, and the length means guessing is not the weak point.
 */
export function mintSeatToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Tokens are stored hashed — see the note in persistence.ts. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Constant-time comparison for the token itself is unnecessary — we compare hashes, and the
 * hash of an attacker-supplied token reveals nothing about the stored one through timing. The
 * lookup is a SQL equality on an indexed primary-key-ish column.
 */
export function resumeUrl(origin: string, roomCode: string, token: string): string {
  return `${origin}/r/${roomCode}#${token}`
}

// --- D37: tournaments -------------------------------------------------------------------------

/**
 * A tournament code, prefixed so it can never be mistaken for a room code.
 *
 * Same alphabet and same length, with a `T-` in front. The router should never have to guess
 * which kind of code it is holding, and a six-character string that is valid as both is a bug
 * waiting for the day somebody pastes one into the wrong box — at which point they join a
 * stranger's match instead of getting a 404.
 */
const TOURNAMENT_PREFIX = 'T-'

export function generateTournamentCode(): string {
  return `${TOURNAMENT_PREFIX}${generateRoomCode()}`
}

export function normalizeTournamentCode(input: string): string {
  return input.trim().toUpperCase()
}

export function isTournamentCode(input: string): boolean {
  const code = normalizeTournamentCode(input)
  return code.startsWith(TOURNAMENT_PREFIX) && isRoomCode(code.slice(TOURNAMENT_PREFIX.length))
}

/**
 * D41 — an entrant's credential for their seat in a tournament match.
 *
 * The same 256 bits from the same CSPRNG as a seat token, and the same trade (§17): it lives in a
 * link, it will end up in browser history, and losing the browser loses it. That is why D41 also
 * gives the organizer a way to re-mint one — the token is the convenience, the organizer is the
 * recovery.
 *
 * **Not** the player id. Gating a seat on the player id would lock an entrant out of their own
 * match the moment they opened it on a phone (D35), which is the exact failure this exists to
 * prevent. The token authorises; the player id still attributes.
 */
export const mintEntrantToken = mintSeatToken

/** The tournament's public page. The entrant token rides in the fragment, like a resume link. */
export function tournamentUrl(origin: string, code: string, token?: string): string {
  return token ? `${origin}/t/${code}#${token}` : `${origin}/t/${code}`
}

/**
 * D20 — the join URL carries the room code and nothing else.
 *
 * The hash was cut because §11 snapshots the resolved ruleset into the creation event, and a
 * joiner reads that snapshot. It is immutable by construction, so there is nothing to go stale
 * and nothing for a URL hash to guard.
 */
export function joinUrl(origin: string, roomCode: string): string {
  return `${origin}/j/${roomCode}`
}

// --- D44: a record with no room behind it -------------------------------------------------------

/**
 * D44 — the code for a match that was added by hand rather than played here.
 *
 * `matches` is keyed by room code, so a backfilled game needs one, and it must be a code no room
 * will ever have: the registry upserts on that key, so a hand-added record wearing a plausible
 * six-character code would be silently overwritten the day `generateRoomCode` produced it for a
 * real game. Prefixed for the same reason a tournament code is — the router should never have to
 * guess what kind of code it is holding — and readable at a glance, because the history and the
 * dashboard both put it on screen next to codes that *are* rooms.
 */
const MANUAL_PREFIX = 'M-'

export function generateManualCode(): string {
  return `${MANUAL_PREFIX}${generateRoomCode()}`
}

/*
 * There is deliberately no `isManualCode` beside this, unlike `isRoomCode` and
 * `isTournamentCode`. Nothing on the server has to recognise one: `isRoomCode` already rejects an
 * eight-character code, so a record can never address a room, and the only reader that cares is
 * the history page — which is on the other side of the boundary `check-boundaries.mjs` enforces
 * and keeps its own `isHandAdded`. A predicate written here for symmetry would be a second
 * definition of the prefix that nothing calls.
 */
