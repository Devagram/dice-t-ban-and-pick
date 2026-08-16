import { useEffect, useState } from 'react'

import { fetchTournament, type TournamentView } from '../api.js'
import { Bracket } from '../components/Bracket.js'
import { playerId } from '../player.js'

/**
 * **D37 — the tournament page.**
 *
 * Public and read-only, like `/history`: a bracket is worth watching whether or not you are in it,
 * and most people looking at one are not. There is no token in the URL for a spectator and no
 * prompt for one.
 *
 * The socket carries the whole bracket on connect and again on every change (Phase 5), so this
 * screen holds no derived state and never merges a delta — the same argument D17 makes for a
 * match. The initial `fetch` exists only so the page has something to draw before the socket
 * opens; the first frame supersedes it a moment later.
 */
export function Tournament({ code, onBack }: { code: string; onBack: () => void }) {
  const [view, setView] = useState<TournamentView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let alive = true
    let socket: WebSocket | null = null

    fetchTournament(code)
      .then((t) => {
        if (!alive) return
        setView(t)

        /*
         * D37 Phase 8 — an archived bracket has nothing to watch.
         *
         * The tournament object was swept a week after its last activity (D42) and this came from
         * the registry instead. It is final by construction, so opening a socket would buy a
         * connection that immediately closes and a badge saying "Reconnect" about a tournament
         * that finished a month ago.
         */
        if (t.archived) return

        /*
         * No reconnect ladder here, unlike `transport.ts`.
         *
         * A match socket must survive a phone changing networks, because a player who cannot act
         * is stuck. A bracket watcher who drops off sees a stale bracket and can refresh, and the
         * page says whether it is live. Building the backoff machinery a second time for that
         * would be carrying weight the case does not justify — and the honest signal is the badge.
         *
         * Opened after the first read rather than beside it, so a frame that arrives while the
         * read is still in flight cannot be overwritten by the staler answer landing second.
         */
        const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
        socket = new WebSocket(`${scheme}://${location.host}/api/tournament/${code}/ws`)
        socket.addEventListener('open', () => alive && setLive(true))
        socket.addEventListener('close', () => alive && setLive(false))
        socket.addEventListener('message', (event: MessageEvent<string>) => {
          if (!alive) return
          const message = JSON.parse(event.data) as { type: string; view?: TournamentView }
          if (message.type === 'BRACKET' && message.view) setView(message.view)
        })
      })
      .catch(() => {
        if (alive) setError('Could not find that tournament.')
      })

    return () => {
      alive = false
      socket?.close()
    }
  }, [code])

  if (error) {
    return (
      <main className="screen">
        <p className="alert" role="alert">
          {error}
        </p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </main>
    )
  }

  if (!view) {
    return (
      <main className="screen">
        <p className="panel__empty">Loading…</p>
      </main>
    )
  }

  const me = playerId()
  const champion = view.champion
    ? (view.entrants.find((e) => e.entrantId === view.champion)?.displayName ?? view.champion)
    : null

  /*
   * "Your match is ready" — the affordance that stops an entrant having to be *sent* a link.
   *
   * Only shown for a slot that is genuinely playable and has a room open. A `PENDING` slot with
   * your name on it is not something to act on yet, and offering it would be an invitation to sit
   * in a room whose opponent does not exist.
   */
  const mine = view.slots.find(
    (s) =>
      s.roomCode !== null &&
      (s.status === 'READY' || s.status === 'LIVE') &&
      s.entrants.some((entrantId) => entrantId !== null && byPlayer(view, entrantId) === me),
  )

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">{view.code}</h1>
        <p className="hero__sub">
          {view.format === 'DOUBLE_ELIMINATION' ? 'Double elimination' : 'Single elimination'} ·{' '}
          {view.entrants.length} entrants
          {view.grandFinalReset ? ' · bracket reset' : ''}
        </p>
        {/* Three states, not two: watching, dropped, and nothing left to watch. */}
        <span className={`tlive ${live ? 'tlive--on' : ''}`}>
          {view.archived ? 'Archived' : live ? 'Live' : 'Reconnect'}
        </span>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      {champion ? (
        <p className="alert alert--notice" role="status">
          {champion} wins.
        </p>
      ) : null}

      {mine ? (
        <section className="panel">
          <h2 className="panel__title">Your match is ready</h2>
          <p className="field__help">
            {mine.slot.id} · {mine.modeId}
          </p>
          {/*
           * A plain link, not a fetch. Seating is the consent (§12.3) and it happens on the match
           * page with the entrant token from this page's own URL fragment — the tournament never
           * sits anybody down on their behalf.
           */}
          <a className="btn btn--primary" href={`/j/${mine.roomCode}${location.hash}`}>
            Go to your match
          </a>
        </section>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Bracket</h2>
        <Bracket view={view} youArePlayerId={me} />
      </section>

      <section className="panel">
        <h2 className="panel__title">Entrants</h2>
        <ol className="tentrants">
          {view.entrants.map((entrant) => (
            <li key={entrant.entrantId} className="tentrant">
              <span className="tentrant__seed">{entrant.seed}</span>
              <span className="tentrant__name">{entrant.displayName}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}

const byPlayer = (view: TournamentView, entrantId: string): string | undefined =>
  view.entrants.find((e) => e.entrantId === entrantId)?.playerId
