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
export function claimSeat(roomCode: string, entrantToken?: string): Promise<ClaimSeatResponse> {
  const player = currentPlayer()
  return fetch(`/api/match/${roomCode}/seat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: player.id,
      displayName: player.name,
      /*
       * D41 — the entrant token, when this room is a bracket match.
       *
       * Its absence was a real bug: the tournament page links an entrant to `/j/CODE#token`, the
       * lobby dropped the fragment, and the seat claim arrived bare — so every entrant met "this
       * seat is reserved — open the match from your entrant link" *having done exactly that*. The
       * worker's own test client had always sent one, which is how the gap survived a suite that
       * plays whole tournaments: the test client could do something the real client could not.
       */
      ...(entrantToken ? { entrantToken } : {}),
    }),
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
    /** Absent on a D44 record, which nobody drafted for. Both readers already guard on it. */
    seats?: Record<'A' | 'B', HeroesOfSeat>
  } | null
  /** D37 — present only for a bracket match. The history page badges these. */
  tournamentId?: string
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
  /**
   * What each side drafted — absent on a match added by hand (D44), which nobody drafted for.
   *
   * Optional because it always could be: both readers have guarded on it since they were written,
   * and the type claiming otherwise was the kind of promise that holds until the first row that
   * did not come from a played match.
   */
  seats?: Record<'A' | 'B', HeroesOfSeat>
}

/**
 * What one seat brought, used, and — since D45 — used in which round.
 *
 * `lineup` is indexed against `rounds`: position two is the hero that played round three. Absent
 * on every record from before D45, which is why the hero board reports what it cannot credit.
 */
export interface HeroesOfSeat {
  drafted: string[]
  played: string[]
  metaBan: string | null
  lineup?: (string | null)[]
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

/**
 * D45 — every character that has been drafted here, with what it did on the table.
 *
 * `unattributedRounds` is part of the answer rather than a footnote: rounds played before D45
 * stored which characters a seat used but not which round each was used in, so they count towards
 * `drafted` and `played` and towards nobody's win-loss record. A board that did not say so would
 * look like a group who barely play.
 */
export interface HeroStanding {
  characterId: string
  drafted: number
  played: number
  wins: number
  losses: number
  draws: number
  /** The opponents this hero is up on, furthest ahead first. At most three. */
  best: HeroMatchup[]
  /** The opponents it is down against, furthest behind first. At most three. */
  worst: HeroMatchup[]
}

/**
 * One hero's record against one other, in the rounds the two have met.
 *
 * Split on wins against losses rather than on a rate, so a draw never has to be priced: up is
 * best, down is worst, and level is neither.
 */
export interface HeroMatchup {
  characterId: string
  wins: number
  losses: number
  draws: number
}

export interface HeroBoard {
  heroes: HeroStanding[]
  unattributedRounds: number
}

export function fetchHeroes(): Promise<HeroBoard> {
  return fetch('/api/heroes').then(json<HeroBoard>)
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
    /**
     * D46 — which hero each seat played in each round, indexed like `rounds`.
     *
     * Sending one replaces that seat's whole lineup, so the dashboard sends what it is showing
     * rather than a patch: a partial lineup would be indistinguishable from a round the admin
     * meant to clear.
     */
    aLineup?: (string | null)[]
    bLineup?: (string | null)[]
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

/**
 * D44 — files a match this deployment never saw.
 *
 * Every field is what the admin typed, because there is no log to read it off. `aId`/`bId` may be
 * omitted for a seat that has no player id yet — the server mints one from the name, and D35's
 * merge is how it gets folded into a real id once that person opens the site.
 */
export function adminAddMatch(
  key: string,
  entry: {
    aId?: string
    bId?: string
    aName?: string
    bName?: string
    winnerId: 'A' | 'B' | null
    scoreA: number
    scoreB: number
    rounds?: (('A' | 'B' | 'TIE') | null)[]
    /** D46 — the heroes, if the admin named them. What makes an added game reach `/heroes`. */
    aLineup?: (string | null)[]
    bLineup?: (string | null)[]
    playedAt?: number
  },
): Promise<MatchRecord> {
  return fetch('/api/admin/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(entry),
  })
    .then(json<{ match: MatchRecord }>)
    .then((r) => r.match)
}

/**
 * Whether this record was added by hand rather than played here (D44).
 *
 * Read off the room code, which for a hand-added record is minted with a prefix no room can have.
 * That is not a decoration: a row nobody's client ever reported is a weaker claim than one two
 * seats agreed on, and the history says which it is looking at rather than presenting both as the
 * same kind of fact.
 */
export function isHandAdded(roomCode: string): boolean {
  return roomCode.startsWith('M-')
}

export function adminDeleteMatch(key: string, roomCode: string): Promise<void> {
  return fetch('/api/admin/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ roomCode }),
  }).then(json<{ ok: true }>) as unknown as Promise<void>
}

// --- D37: tournaments -----------------------------------------------------------------------------

/**
 * The bracket, as the server sends it.
 *
 * Declared here rather than imported, because the client **cannot** import `@banpick/bracket` —
 * `scripts/check-boundaries.mjs` fails the build if it tries. That rule is about authority rather
 * than secrecy: a client holding `advance` would eventually predict a result optimistically, and
 * an optimistic bracket disagreeing with the server is the two-truths failure D39 exists to
 * prevent. So the client is told the whole bracket and given no way to compute one.
 */
export type SlotStatus =
  | 'PENDING'
  | 'READY'
  | 'DONE'
  | 'BYE'
  | 'DISPUTED'
  | 'VOIDED'
  | 'DRAWN'
  /** D37 — overlaid by the tournament, not derived by the bracket: a room exists and is being played. */
  | 'LIVE'

export type BracketSide = 'WINNERS' | 'LOSERS' | 'GRAND_FINAL'

export interface BracketSlot {
  slot: {
    id: string
    side: BracketSide
    round: number
    match: number
    winnerTo: string | null
    loserTo: string | null
  }
  status: SlotStatus
  /** `null` where the side is a bye or not yet known — `status` says which. */
  entrants: [string | null, string | null]
  winner: string | null
  position: string
  modeId: string
  roomCode: string | null
}

export interface TournamentEntrant {
  entrantId: string
  playerId: string
  displayName: string
  seed: number
}

export interface TournamentView {
  code: string
  status: string
  format: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION'
  grandFinalReset: boolean
  createdAt: number
  entrants: TournamentEntrant[]
  slots: BracketSlot[]
  champion: string | null
  complete: boolean
  /**
   * D37 Phase 8 — this bracket came from the registry's archive, not from a live tournament.
   *
   * Set only once the tournament object has been swept (D42, seven days). Nothing here can change
   * again, so there is nothing to watch: the page says so and does not open a socket.
   */
  archived?: boolean
}

/** D37 Phase 8 — one line per tournament, from the registry rather than from any tournament. */
export interface TournamentSummary {
  code: string
  format: string
  entrants: string[]
  champion: string | null
  createdAt: number
  updatedAt: number
  complete: boolean
}

/**
 * Every tournament this deployment has seen.
 *
 * Served by `RegistryDO`, not by the tournaments themselves — those are swept a week after their
 * last activity (D42), and a week later is usually exactly when somebody wants to look up who won.
 */
export function fetchTournaments(): Promise<TournamentSummary[]> {
  return fetch('/api/tournaments')
    .then(json<{ tournaments: TournamentSummary[] }>)
    .then((r) => r.tournaments ?? [])
}

export function fetchTournament(code: string): Promise<TournamentView> {
  return fetch(`/api/tournament/${encodeURIComponent(code)}`).then(json<TournamentView>)
}

/** What the organizer types: a name, and the player id it should count towards. */
export interface EntrantInput {
  playerId: string
  displayName: string
}

export interface TournamentConfigInput {
  format?: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION'
  seeding?: 'AS_ENTERED' | 'RANDOM' | 'MANUAL'
  grandFinalReset?: boolean
  default?: { modeId: string }
  overrides?: Record<string, { modeId: string }>
}

/**
 * The one response in the app that cannot be fetched again.
 *
 * The organizer token and every entrant token exist here and nowhere else — only their hashes are
 * stored (D41), the same contract D17 gives a seat token. Whatever the screen does not put on
 * screen is gone.
 */
export interface CreatedTournament {
  code: string
  url: string
  organizerToken: string
  entrants: { entrantId: string; displayName: string; seed: number; url: string }[]
}

export function createTournament(body: {
  entrants: EntrantInput[]
  config: TournamentConfigInput
}): Promise<CreatedTournament> {
  return fetch('/api/tournament', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<CreatedTournament>)
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
