/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SELF } from 'cloudflare:test'
import type {
  Action,
  Character,
  ClaimSeatResponse,
  ClientMessage,
  CreateMatchResponse,
  LobbyPreview,
  PlayerActionPayload,
  PlayerView,
  Seat,
  ServerMessage,
} from '@banpick/types'

/**
 * A headless client, for the Phase 3 exit criteria.
 *
 * "Two headless clients play a complete `bring-ban1` match over WebSocket." So this is a real
 * client: it holds a seat token, it speaks the wire protocol, and — importantly — **it has no
 * access to the engine**. It renders `legalActions` off the frames it receives and nothing
 * else, which is exactly the constraint §11.4 and D18 place on the real one. If a test can only
 * pass by peeking at server state, that is a finding about the protocol.
 */
/**
 * How long a "wait for a frame" gives up after, in **wall-clock milliseconds**.
 *
 * These waits used to count turns of `scheduler.wait(1)`, and that is what put two long matches
 * in `players-merge` and `authority` on the floor in GitHub Actions while the same suite was
 * green here and green on the deploy. `scheduler.wait(1)` yields for *at least* a millisecond;
 * on a runner with two cores and a dozen workerd isolates competing for them it is regularly far
 * more. So "200 turns" was 200ms on a laptop and an unknowable stretch on CI — the test was
 * reporting the scheduler rather than the server, which is precisely what this file's own comment
 * on `settle` warns against and then did.
 *
 * Generous on purpose. Nothing waits the full time unless the frame genuinely never comes: every
 * one of these returns on the first turn its condition holds, so the only case that pays for a
 * large backstop is a real failure, and a real failure is worth waiting ten seconds to report
 * honestly. The worker project's `testTimeout` is set above this in `vitest.config.ts` so it is
 * *this* message that fires — "no frame in 10s, last rejection …" rather than vitest's generic
 * one, which names nothing.
 */
const FRAME_TIMEOUT_MS = 10_000

/**
 * Polls until a condition holds or the deadline passes.
 *
 * Yields with `scheduler.wait(1)` between checks rather than spinning: the frame arrives on the
 * socket's own task, so a loop that never yields would starve the very thing it is waiting for.
 */
async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() >= deadline) return false
    await scheduler.wait(1)
  }
}

export class TestClient {
  private socket!: WebSocket
  /** Every frame received, in order. The redaction assertions run against these strings. */
  readonly frames: string[] = []
  private views: PlayerView[] = []
  private rejections: Extract<ServerMessage, { type: 'REJECTED' }>[] = []
  private errors: Extract<ServerMessage, { type: 'ERROR' }>[] = []
  /** Opponent progress pings — cosmetic, ephemeral, and asserted on for what they must NOT carry. */
  readonly progress: Extract<ServerMessage, { type: 'OPPONENT_PROGRESS' }>[] = []
  readonly rematches: Extract<ServerMessage, { type: 'REMATCH' }>[] = []
  readonly amendments: Extract<ServerMessage, { type: 'RESULT_AMENDED' }>[] = []
  /** D37 — bracket frames, for the tournament socket. Always empty on a match client. */
  readonly brackets: unknown[] = []

  private constructor(
    readonly seatToken: string,
    readonly websocketUrl: string,
    /** From the claim response, when there was one. A resuming client has only its token. */
    private readonly claimedSeat: Seat | null,
  ) {}

  /**
   * `player` is the seated identity (D28/D29).
   *
   * Defaulted rather than optional: since a name became a record, the server refuses an unnamed
   * seat outright, so a test client that could seat anonymously would be testing something no
   * real client can do. Pass `null` to exercise the refusal deliberately.
   */
  static async claimSeat(
    roomCode: string,
    player: { playerId: string; displayName?: string } | null = {
      playerId: `p-${crypto.randomUUID()}`,
    },
  ): Promise<TestClient> {
    const claim = player
      ? { playerId: player.playerId, displayName: player.displayName ?? player.playerId }
      : null
    const response = await SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
      method: 'POST',
      ...(claim
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) }
        : {}),
    })
    if (!response.ok)
      throw new Error(`claimSeat failed: ${response.status} ${await response.text()}`)
    const body = (await response.json()) as ClaimSeatResponse
    return new TestClient(body.seatToken, body.websocketUrl, body.seat)
  }

  /**
   * D41 — sits down in a tournament match with an entrant token.
   *
   * The player id is deliberately a fresh random one every time: the whole point of the entrant
   * token is that it works from a browser the tournament has never seen, and a test that passed
   * the registered id would prove nothing about that. The server fills the seat under the
   * entrant's *registered* identity regardless of what is sent here.
   */
  static async claimSeatWithToken(roomCode: string, entrantToken: string): Promise<TestClient> {
    const response = await SELF.fetch(`https://example.com/api/match/${roomCode}/seat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: `browser-${crypto.randomUUID()}`,
        displayName: 'whatever this browser thinks',
        entrantToken,
      }),
    })
    if (!response.ok) {
      throw new Error(`claimSeatWithToken failed: ${response.status} ${await response.text()}`)
    }
    const body = (await response.json()) as ClaimSeatResponse
    return new TestClient(body.seatToken, body.websocketUrl, body.seat)
  }

  /**
   * Reconnects with a stored token.
   *
   * A refresh, a new tab, and a different device are the same operation under D17, and the
   * token is what makes them indistinguishable. Note that a client is never told its seat by
   * anything but a frame — a client that remembers its own seat is one that can be wrong
   * about it.
   */
  static async resume(seatToken: string, websocketUrl: string): Promise<TestClient> {
    return new TestClient(seatToken, websocketUrl, null).connect()
  }

  /**
   * The server's answer wins.
   *
   * A resuming client has only a token and learns its seat from the first frame — which is the
   * honest shape: the seat is a fact about the token, held by the authority, not something a
   * client gets to remember and be wrong about.
   */
  get seat(): Seat {
    const seat = this.views.at(-1)?.seat ?? this.claimedSeat
    if (!seat) throw new Error('this client has neither a frame nor a claim response')
    return seat
  }

  /** Opens the socket and waits for the resync frame D17 promises on connect. */
  async connect(): Promise<this> {
    const url = new URL(this.websocketUrl)
    const response = await SELF.fetch(
      `https://example.com${url.pathname}?token=${this.seatToken}`,
      { headers: { Upgrade: 'websocket' } },
    )
    if (response.status !== 101) {
      throw new Error(`upgrade failed: ${response.status} ${await response.text()}`)
    }

    const socket = response.webSocket
    if (!socket) throw new Error('no webSocket on the 101 response')
    socket.accept()
    this.socket = socket

    socket.addEventListener('message', (event: MessageEvent) => {
      const raw = String(event.data)
      this.frames.push(raw)
      const message = JSON.parse(raw) as ServerMessage
      if (message.type === 'VIEW') this.views.push(message.view)
      else if (message.type === 'REJECTED') this.rejections.push(message)
      else if (message.type === 'OPPONENT_PROGRESS') this.progress.push(message)
      else if (message.type === 'REMATCH') this.rematches.push(message)
      else if (message.type === 'RESULT_AMENDED') this.amendments.push(message)
      // D37 — the tournament socket's only frame. A match client never receives one; it is listed
      // here because `ServerMessage` is one union and the exhaustive else below is what keeps a
      // new frame type from being silently filed as an error.
      else if (message.type === 'BRACKET') this.brackets.push(message.view)
      // Everything left really is an error. Named types are listed above so that adding a
      // server message and forgetting this line is a type error rather than a silent
      // reclassification into `errors`.
      else this.errors.push(message)
    })

    /*
     * A fixed settle, deliberately, after trying the alternative.
     *
     * `waitForFrame(0)` looks more correct — wait for the opening VIEW rather than for four turns
     * — and it made three unrelated tests hang. Some connects legitimately receive no frame, so
     * blocking on one turns "nothing to say" into a timeout. Reverted rather than left half-fixed.
     *
     * Known consequence: `session.test.ts`'s refresh loop can still flake, rarely, when a resumed
     * client is inspected before its first view lands. That is a real gap and it is written down
     * here rather than papered over.
     */
    await this.settle()
    return this
  }

  /**
   * Drops the socket — the "kill one client" of the exit criteria.
   *
   * 1001 "going away" rather than 1006: 1006 is reserved for a connection that died without a
   * close frame and cannot be sent deliberately. For what is under test the distinction does
   * not matter — the seat is held by the token, so any way of losing a socket is the same
   * non-event (D17).
   */
  kill(): void {
    this.socket.close(1001, 'test kill')
  }

  /** Counted so the §11 free-plan headroom test can budget inbound DO requests. */
  private sent = 0

  get sentCount(): number {
    return this.sent
  }

  send(message: ClientMessage): void {
    this.sent++
    this.socket.send(JSON.stringify(message))
  }

  /** Bypasses serialization, so a test can send something that is genuinely not JSON. */
  sendRaw(frame: string): void {
    this.sent++
    this.socket.send(frame)
  }

  /** Sends an action and waits for the server to answer with something. */
  async act(
    payload: PlayerActionPayload,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<void> {
    const before = this.frames.length
    this.send({ type: 'ACTION', idempotencyKey, payload })
    await this.waitForFrame(before)
  }

  async resync(): Promise<void> {
    const before = this.frames.length
    this.send({ type: 'RESYNC' })
    await this.waitForFrame(before)
  }

  /**
   * Waits until a new frame arrives, or fails saying so.
   *
   * Waiting on the *condition* rather than a fixed number of turns matters: a server that never
   * replies is a real failure and has to look like one, not like a flaky test. If a REJECTED or
   * ERROR frame arrived instead of a view, that is still a reply and the caller inspects it.
   */
  async waitForFrame(since: number, timeoutMs = FRAME_TIMEOUT_MS): Promise<void> {
    if (await until(() => this.frames.length > since, timeoutMs)) return
    throw new Error(
      `client ${this.seatToken.slice(0, 8)} received no frame within ${timeoutMs}ms. ` +
        `Last error: ${JSON.stringify(this.lastError)}. ` +
        `Last rejection: ${JSON.stringify(this.lastRejection)}.`,
    )
  }

  /**
   * Lets any fan-out addressed to this client land.
   *
   * A fixed number of turns, which is correct **only** for negative assertions — proving nothing
   * arrived means waiting a while and then looking. For a positive one, use `waitForError` or
   * `waitForRejection`: asserting on a frame after a fixed wait is a race that passes on a fast
   * machine and fails on a loaded CI runner, which is exactly how this file lost an afternoon.
   */
  async settle(turns = 4): Promise<void> {
    for (let i = 0; i < turns; i++) await scheduler.wait(1)
  }

  /**
   * Waits for a protocol ERROR, or fails saying none came.
   *
   * Same reasoning as `waitForFrame`: a server that never replies is a real failure and must look
   * like one. The timeout is generous because it is a backstop, not a delay — a passing case
   * returns on the first turn the frame exists.
   */
  async waitForError(
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Extract<ServerMessage, { type: 'ERROR' }>> {
    const error = (await until(() => this.errors.length > 0, timeoutMs))
      ? this.errors.at(-1)
      : undefined
    if (error) return error
    throw new Error(
      `client ${this.seatToken.slice(0, 8)} received no ERROR within ${timeoutMs}ms. ` +
        `Last rejection: ${JSON.stringify(this.lastRejection)}.`,
    )
  }

  /**
   * Waits for the next PROGRESS frame, rather than for a number of turns.
   *
   * `settle(n)` is right for proving a frame *never* arrives and wrong for proving one did: it
   * passes on a fast machine and fails under load, which is a test that reports the scheduler
   * instead of the server. Same reasoning as `waitForError`.
   */
  async waitForProgress(
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Extract<ServerMessage, { type: 'OPPONENT_PROGRESS' }>> {
    const before = this.progress.length
    const frame = (await until(() => this.progress.length > before, timeoutMs))
      ? this.progress.at(-1)
      : undefined
    if (frame) return frame
    throw new Error(
      `client ${this.seatToken.slice(0, 8)} received no PROGRESS within ${timeoutMs}ms.`,
    )
  }

  /** As `waitForError`, for an action the engine refused rather than a protocol fault. */
  async waitForRejection(
    timeoutMs = FRAME_TIMEOUT_MS,
  ): Promise<Extract<ServerMessage, { type: 'REJECTED' }>> {
    const rejection = (await until(() => this.rejections.length > 0, timeoutMs))
      ? this.rejections.at(-1)
      : undefined
    if (rejection) return rejection
    throw new Error(
      `client ${this.seatToken.slice(0, 8)} received no REJECTED within ${timeoutMs}ms. ` +
        `Last error: ${JSON.stringify(this.lastError)}.`,
    )
  }

  get view(): PlayerView {
    const latest = this.views.at(-1)
    // Note: this message must not mention `this.seat`, which is itself read off the latest
    // view — the two would recurse into each other.
    if (!latest) throw new Error(`client ${this.seatToken.slice(0, 8)} has received no view`)
    return latest
  }

  get viewCount(): number {
    return this.views.length
  }

  get lastRejection(): Extract<ServerMessage, { type: 'REJECTED' }> | undefined {
    return this.rejections.at(-1)
  }

  get lastError(): Extract<ServerMessage, { type: 'ERROR' }> | undefined {
    return this.errors.at(-1)
  }

  /** What this seat may do — read off the frame, never computed locally (§11.4). */
  actions(): Action[] {
    return this.view.legalActions
  }

  action<T extends Action['type']>(type: T): Extract<Action, { type: T }> | undefined {
    return this.actions().find((a) => a.type === type) as Extract<Action, { type: T }> | undefined
  }

  /** True when this seat is being asked for something other than the standing undo. */
  get isAwaited(): boolean {
    return this.actions().some((a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT')
  }
}

// --- Match setup -------------------------------------------------------------------------------

export interface CreateOptions {
  modeId?: string
  draftCount?: 3 | 4
  globalBanned?: string[]
  /** D28. Omitted means the server default, which is the same as the create endpoint's. */
  allowRepeatBans?: boolean
}

export async function createMatch(opts: CreateOptions = {}): Promise<CreateMatchResponse> {
  const response = await SELF.fetch('https://example.com/api/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      modeId: opts.modeId ?? 'base',
      parameters: { draftCount: opts.draftCount ?? 4 },
      globalBanned: opts.globalBanned ?? [],
      ...(opts.allowRepeatBans === undefined ? {} : { allowRepeatBans: opts.allowRepeatBans }),
    }),
  })
  if (!response.ok) throw new Error(`create failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as CreateMatchResponse
}

/**
 * The roster the Worker actually serves.
 *
 * Tests derive character ids from this rather than hardcoding them, so adding a hero to the
 * game does not break the transport tests — which are about frames and races, not about who is
 * in the box.
 */
export async function roster(): Promise<Character[]> {
  const response = await SELF.fetch('https://example.com/api/roster')
  if (!response.ok) throw new Error(`roster failed: ${response.status}`)
  return ((await response.json()) as { characters: Character[] }).characters
}

/** `count` character ids starting at `from`, so two seats can be given disjoint drafts. */
export async function ids(from: number, count: number): Promise<string[]> {
  return (await roster()).slice(from, from + count).map((c) => c.id)
}

export async function preview(roomCode: string): Promise<LobbyPreview> {
  const response = await SELF.fetch(`https://example.com/api/match/${roomCode}/preview`)
  if (!response.ok) throw new Error(`preview failed: ${response.status}`)
  return (await response.json()) as LobbyPreview
}

/** Creates a match and seats two connected clients. The starting point for most tests. */
export async function seatedMatch(
  opts: CreateOptions & { players?: [string, string] } = {},
): Promise<{
  roomCode: string
  a: TestClient
  b: TestClient
}> {
  const { roomCode } = await createMatch(opts)
  // Seats are handed out in order, so the first id belongs to whoever gets seat A.
  const first = await TestClient.claimSeat(
    roomCode,
    opts.players ? { playerId: opts.players[0] } : undefined,
  )
  const second = await TestClient.claimSeat(
    roomCode,
    opts.players ? { playerId: opts.players[1] } : undefined,
  )
  const a = first.seat === 'A' ? first : second
  const b = first.seat === 'A' ? second : first
  await a.connect()
  await b.connect()
  return { roomCode, a, b }
}

// --- Playing -----------------------------------------------------------------------------------

/**
 * Turns an offered `Action` into a concrete payload, choosing the first legal option.
 *
 * `legalActions` describes an option space rather than enumerating submissions — drafting 4 from
 * 75 is over a million combinations — so a client always has to do this. That it can, using only
 * what the frame contains, is itself the assertion that the protocol is complete.
 */
export function materialize(
  action: Action,
  seat: Seat,
  outcome: 'A' | 'B' | 'TIE' = 'A',
): PlayerActionPayload {
  switch (action.type) {
    case 'COMMIT':
      return {
        type: 'COMMIT',
        moduleId: action.moduleId,
        seat,
        picks: action.picks ? action.picks.poolBySlot.map((pool, i) => pool[i]!) : [],
        metaBan: action.metaBan ? action.metaBan.pool[0]! : null,
      }
    case 'RECOMMIT':
      return {
        type: 'RECOMMIT',
        moduleId: action.moduleId,
        seat,
        replacements: action.slots.map((s, i) => ({ index: s.index, characterId: s.pool[i]! })),
      }
    case 'ROLL':
      // Asking for the dice carries no choice — the result was fixed by the seed long before.
      return {
        type: 'ROLL_READY',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
      }

    case 'CHOOSE':
      return {
        type: 'CHOOSE',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        option: action.options[0]!,
      }
    case 'BAN':
      return {
        type: 'BAN',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        tier: 'ROUND',
        target: action.targets[0]!,
      }
    case 'SELECT':
      return {
        type: 'SELECT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        seat,
        slotIndex: action.slots[0]!,
        reason: null,
      }
    case 'REPORT_RESULT':
      return {
        type: 'REPORT_RESULT',
        moduleId: action.moduleId,
        roundIndex: action.roundIndex,
        reportedBy: seat,
        outcome,
      }
    case 'UNDO_LAST_RESULT':
      return { type: 'UNDO_LAST_RESULT', roundIndex: action.roundIndex, requestedBy: seat }
    default:
      throw new Error(`materialize: cannot act on ${action.type}`)
  }
}

/** Plays both seats to a terminal state, reporting `results[n]` for round n. */
/**
 * Plays the current `COMMIT` for whichever seats are being asked for one.
 *
 * Named by intent rather than by module id: `bring-ban1` opens with a **ban** phase and then a
 * **draft** phase, so "commit once and you have drafted" stopped being true on 2026-07-31. A
 * test that wants to be past the whole pre-round sequence should say `commitAll`.
 */
export async function commitPhase(a: TestClient, b: TestClient): Promise<void> {
  for (const client of [a, b]) {
    const commit = client.action('COMMIT')
    if (commit) await client.act(materialize(commit, client.seat))
  }
}

/** Drains every consecutive commit phase — match start to a completed draft in one call. */
export async function commitAll(a: TestClient, b: TestClient): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    if (![a, b].some((c) => c.action('COMMIT'))) return
    await commitPhase(a, b)
  }
  throw new Error('commitAll: still committing after 8 phases')
}

/**
 * Reads until the answer is the one being asserted on, then returns it.
 *
 * The registry is written on a `waitUntil` — D29's reasoning is that no player should wait for the
 * leaderboard — so "play a match, then read the table" is a race by construction. The original
 * answer to that was `settle(40)` and then look, which is the wrong shape for a positive
 * assertion: it passes on a quiet machine and fails on a loaded runner, which is the same defect
 * that took two long matches down in CI. This waits for the *condition* and reports what it last
 * saw when it gives up, so a genuine failure still reads as one.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  what = 'the expected state',
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T = await read()
  for (;;) {
    if (ready(last)) return last
    if (Date.now() >= deadline) {
      throw new Error(`never reached ${what} within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`)
    }
    await scheduler.wait(1)
    last = await read()
  }
}

export async function playToCompletion(
  a: TestClient,
  b: TestClient,
  results: ('A' | 'B' | 'TIE')[] = ['A', 'B', 'A'],
): Promise<void> {
  for (let guard = 0; guard < 120; guard++) {
    if (a.view.status === 'COMPLETE') return

    const actor = [a, b].find((c) => c.isAwaited)
    if (!actor) throw new Error('nobody is being asked to act, and the match is not over')

    const action = actor
      .actions()
      .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
    const outcome = action.type === 'REPORT_RESULT' ? (results[action.roundIndex] ?? 'A') : 'A'
    await actor.act(materialize(action, actor.seat, outcome))
  }
  throw new Error('playToCompletion: the match did not terminate')
}
