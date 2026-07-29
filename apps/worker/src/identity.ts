/// <reference types="@cloudflare/workers-types" />

/**
 * Room codes and seat tokens — the whole identity model, permanently (D19).
 *
 * "Room code plus seat token is the entire identity model for v1", and D19 makes that permanent
 * rather than provisional: there is no tournament layer coming, so no owning entity above a
 * match will ever need to exist.
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
