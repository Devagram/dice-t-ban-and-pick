import { useEffect, useState } from 'react'

import { fetchLobbies, type RoomListing } from '../api.js'

/**
 * **D31 — find a game without being sent a link.**
 *
 * The room code was the whole of access control until now (§1's trust model is a group of friends
 * sharing a link, and D20 keeps the join URL carrying the code and nothing else). This screen
 * widens that from "has the link" to "has the site", which was the owner's explicit call.
 *
 * Refreshed on an interval rather than over a socket. A WebSocket per visitor staring at a list
 * costs a Durable Object connection each and buys a few seconds of latency on a screen nobody
 * sits on for long — and unlike a match, nothing here is worse for being a moment stale.
 */
const REFRESH_MS = 5000

export function Lobbies({ onBack }: { onBack: () => void }) {
  const [rooms, setRooms] = useState<RoomListing[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      fetchLobbies()
        .then((r) => {
          if (!live) return
          setRooms(r)
          setError(null)
        })
        .catch(() => {
          if (!live) return
          // Reads the previous value through the setter rather than closing over `rooms`, which
          // keeps this effect's dependency list genuinely empty — the interval owns the
          // refreshing, and re-running the effect on every poll would stack timers.
          setRooms((previous) => {
            // Keeps whatever was last shown. A dropped poll on a list that refreshes every few
            // seconds is not worth replacing the screen with an error.
            if (previous === null) setError('Could not reach the lobby list.')
            return previous
          })
        })
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const open = rooms?.filter((r) => r.status === 'OPEN') ?? []
  const playing = rooms?.filter((r) => r.status === 'PLAYING') ?? []

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Open games</h1>
        <p className="hero__sub">Join a seat, or watch one already under way</p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Waiting for a player</h2>
        {rooms === null ? (
          <p className="panel__empty">Looking…</p>
        ) : open.length === 0 ? (
          <p className="panel__empty">
            Nobody is waiting right now. Start a match and yours will show up here.
          </p>
        ) : (
          <ul className="lobbylist">
            {open.map((room) => (
              <RoomRow key={room.roomCode} room={room} />
            ))}
          </ul>
        )}
      </section>

      {playing.length > 0 ? (
        <section className="panel">
          <h2 className="panel__title">In progress</h2>
          <ul className="lobbylist">
            {playing.map((room) => (
              <RoomRow key={room.roomCode} room={room} />
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}

function RoomRow({ room }: { room: RoomListing }) {
  const joinable = room.status === 'OPEN'
  return (
    <li className={`lobbyrow ${joinable ? '' : 'lobbyrow--playing'}`}>
      <span className="lobbyrow__who">
        {/* A room can exist before anyone has named themselves, so this has to read as a real
            state rather than as missing data. */}
        {room.hostName || 'Nobody yet'}
      </span>
      <span className="lobbyrow__mode">{room.modeLabel}</span>
      <span className="lobbyrow__age">{sinceOpened(room.openedAt)}</span>
      {joinable ? (
        <a className="btn btn--primary lobbyrow__go" href={`/j/${room.roomCode}`}>
          Take the seat
        </a>
      ) : (
        /*
         * No link, on purpose, until spectating exists.
         *
         * A full room's join page says "Both seats taken" and offers nothing — a button labelled
         * "Watch" pointing at that is a promise the app does not keep. The row still earns its
         * place by saying a game is happening; it just does not pretend you can join it.
         */
        <span className="lobbyrow__go lobbyrow__status">Under way</span>
      )}
    </li>
  )
}

/** Rough on purpose — "4m" answers "is this alive", and a clock would not. */
function sinceOpened(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}
