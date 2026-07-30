import type { ClientMessage, PlayerActionPayload, PlayerView, ServerMessage } from '@banpick/types'

/**
 * The client's entire relationship with the authority.
 *
 * §11 non-negotiable 4: *"The client renders `legalActions()` and nothing else. It never
 * computes legality independently — and it is not given the code that could (D18)."* So this
 * file holds a socket and a `PlayerView`, and there is nothing else to hold. Every control the
 * UI draws comes out of `view.legalActions`; nothing here decides what is allowed, and there is
 * no local copy of state to drift from the server's.
 */

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface TransportState {
  status: ConnectionStatus
  view: PlayerView | null
  /** The last action the server refused, cleared when the next one is accepted. */
  rejection: { code: string; detail: string } | null
  error: { code: string; detail: string } | null
  /**
   * The opponent's self-reported progress through a hidden commit, or `null`.
   *
   * Cleared on every new view, because a state change means the count it described is stale —
   * a bar left showing "2 of 4" after the draft resolved would be worse than showing nothing.
   */
  progress: { filled: number; of: number } | null
}

export interface Transport {
  send(payload: PlayerActionPayload): void
  resync(): void
  /** Tells the opponent how far along you are. Cosmetic; carries a count and nothing else. */
  reportProgress(filled: number, of: number): void
  close(): void
}

/**
 * D17 — "Refreshing the page must be a non-event. So must closing the tab, losing wifi, and
 * picking the match back up on a different device."
 *
 * Reconnection is therefore automatic and needs no user action. Backoff exists so a server that
 * is genuinely down is not hammered, capped low because the failure this covers is a phone
 * changing networks, and thirty seconds of a blank screen for that would be its own bug.
 */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000]

export function connect(
  websocketUrl: string,
  seatToken: string,
  onChange: (patch: Partial<TransportState>) => void,
): Transport {
  let socket: WebSocket | null = null
  let attempt = 0
  let closedByUs = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const url = `${websocketUrl}?token=${encodeURIComponent(seatToken)}`

  const open = (): void => {
    onChange({ status: attempt === 0 ? 'connecting' : 'reconnecting' })
    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      attempt = 0
      onChange({ status: 'open' })
      // No resync request needed: the DO sends a full projection on socket open. D17 is
      // explicit that reconnect is "a full `project()` resync — no deltas, no
      // replay-from-client", which is what makes a refresh indistinguishable from a first load.
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as ServerMessage
      switch (message.type) {
        case 'VIEW':
          // A new view supersedes any progress ping: the count described the state we have
          // just replaced, so keeping it would leave a stale bar on screen.
          onChange({ view: message.view, rejection: null, error: null, progress: null })
          break
        case 'REJECTED':
          onChange({ rejection: { code: message.code, detail: message.detail } })
          break
        case 'ERROR':
          onChange({ error: { code: message.code, detail: message.detail } })
          break
        case 'OPPONENT_PROGRESS':
          onChange({ progress: { filled: message.filled, of: message.of } })
          break
      }
    })

    socket.addEventListener('close', () => {
      if (closedByUs) {
        onChange({ status: 'closed' })
        return
      }
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
      attempt++
      onChange({ status: 'reconnecting' })
      timer = setTimeout(open, delay)
    })

    // A socket error is always followed by a close, which is where reconnection is handled.
    socket.addEventListener('error', () => {})
  }

  open()

  const post = (message: ClientMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    // A message sent while disconnected is dropped rather than queued. The reconnect brings a
    // full view, so a queued action would be replayed against a state the player never saw —
    // and §12 forbids withdrawing a commit, which makes that unfixable.
  }

  return {
    send(payload) {
      // Every action carries a key, so a double-tapped button, a flaky network retry, and a
      // reconnect-then-retry all collapse to one appended event (Phase 3).
      post({ type: 'ACTION', idempotencyKey: crypto.randomUUID(), payload })
    },
    resync() {
      post({ type: 'RESYNC' })
    },
    reportProgress(filled, of) {
      post({ type: 'PROGRESS', filled, of })
    },
    close() {
      closedByUs = true
      clearTimeout(timer)
      socket?.close(1000, 'leaving')
    },
  }
}

// --- Seat storage (D17) ---------------------------------------------------------------------

interface StoredSeat {
  seatToken: string
  websocketUrl: string
}

/**
 * D17 — the token lives in `localStorage` keyed by match, "so a refresh reconnects with no user
 * action at all", and in a copyable resume link so a device change and a cleared cache are both
 * recoverable.
 */
const seatKey = (roomCode: string): string => `banpick:seat:${roomCode}`

export function rememberSeat(roomCode: string, seat: StoredSeat): void {
  try {
    localStorage.setItem(seatKey(roomCode), JSON.stringify(seat))
  } catch {
    // Private browsing, or storage full. The resume link still works, which is exactly why D17
    // has two mechanisms rather than one.
  }
}

export function recallSeat(roomCode: string): StoredSeat | null {
  try {
    const raw = localStorage.getItem(seatKey(roomCode))
    return raw ? (JSON.parse(raw) as StoredSeat) : null
  } catch {
    return null
  }
}

export function forgetSeat(roomCode: string): void {
  try {
    localStorage.removeItem(seatKey(roomCode))
  } catch {
    // Nothing to do, and nothing depends on it.
  }
}
