import { useEffect, useState } from 'react'
import type { PlayerView } from '@banpick/types'

import { openRematch } from '../api.js'
import { rememberSeat, wsUrlFor } from '../transport.js'

/**
 * **D32 — play again, without building the match again.**
 *
 * A series was: go home, re-pick the mode, the parameters and the global bans, create, copy the
 * link, send it. Everything in that list is already known — it is the ruleset the finished match
 * is still holding — so this opens a room with the same terms and points both players at it.
 *
 * **D53 — and it no longer stops at the door.** It used to hand both players a link to the new
 * room's join page, where they retyped a name and re-took a seat under terms they had just
 * played a whole match under; the reasoning was §12.3, seating is consent. What that rule
 * protects is consenting to terms you have not seen, and a rematch has none — so the server now
 * fills both seats and sends each client its own token, and this goes straight in.
 *
 * The old path is still here and still correct, because the token is allowed to be absent: a seat
 * the server could not resolve gets the join link it always got, rather than a dead end.
 */
export function PlayAgain({
  view,
  roomCode,
  seatToken,
  rematch,
}: {
  view: PlayerView
  roomCode: string
  seatToken: string
  /** Set once either seat has opened one — pushed over the socket the two already share. */
  rematch: { roomCode: string; by: string; seatToken?: string } | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * D53 — the seat that arrived over the socket walks itself in.
   *
   * This is the opponent's path: they pressed nothing, and the frame is the first they hear of
   * it. Navigating on the frame rather than on a click is the whole of "you do not have to
   * rejoin" for the player who did not open the room — the presser gets there from the button's
   * own `.then` below, and both end up making the same navigation with the same URL.
   *
   * Gated on COMPLETE for the same reason the button is: D15's undo reopens a finished match, and
   * `rematch` deliberately outlives a new VIEW, so without this a player looking at a match that
   * has been reopened underneath them would be dragged out of it.
   */
  const next = rematch?.seatToken && view.status === 'COMPLETE' ? rematch : null
  useEffect(() => {
    if (!next?.seatToken) return
    // Also written by the transport when the frame landed. Repeated here because the presser's
    // token can arrive in the HTTP response with no frame behind it, and `/j/CODE` reads this to
    // decide between a seated match and a join page.
    rememberSeat(next.roomCode, {
      seatToken: next.seatToken,
      websocketUrl: wsUrlFor(next.roomCode),
    })
    location.assign(`/j/${next.roomCode}`)
  }, [next])

  // Only at the end, and only a real end: D15's undo reopens a completed match, and a rematch
  // offered over a match that is live again would be a room nobody is coming to.
  if (view.status !== 'COMPLETE') return null

  if (rematch) {
    const theirs = rematch.by !== view.seat
    const them = view.opponent.player?.name || 'They'
    // D53 — seated is the ordinary case now, so it gets the plain sentence and the link becomes
    // the fallback for a navigation that has not happened yet.
    if (rematch.seatToken) {
      return (
        <section className="playagain">
          <p className="playagain__note">
            {theirs ? `${them} opened a rematch — same rules, same seats.` : 'Rematch opened.'} Your
            seat is saved. Taking you there…
          </p>
          <a className="btn btn--primary" href={`/j/${rematch.roomCode}`}>
            Go to the rematch
          </a>
        </section>
      )
    }
    return (
      <section className="playagain">
        <p className="playagain__note">
          {theirs
            ? `${them} opened a rematch — same rules.`
            : 'Rematch opened. Waiting for them to join.'}
        </p>
        <a className="btn btn--primary" href={`/j/${rematch.roomCode}`}>
          {theirs ? 'Join the rematch' : 'Go to the rematch'}
        </a>
      </section>
    )
  }

  return (
    <section className="playagain">
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(null)
          openRematch(roomCode, seatToken)
            .then((room) => {
              // Both seats get the same room from the server, so whoever pressed second is not
              // creating a second one — they are being handed the first, with their own seat in
              // it. Stored before navigating: a token that is only in flight is one a closed tab
              // loses, and this is the click that makes the next set exist.
              if (room.seatToken) {
                rememberSeat(room.roomCode, {
                  seatToken: room.seatToken,
                  websocketUrl: wsUrlFor(room.roomCode),
                })
              }
              location.assign(`/j/${room.roomCode}`)
            })
            .catch(() => {
              setError('Could not open a rematch. The result is still recorded.')
              setBusy(false)
            })
        }}
      >
        {busy ? 'Opening…' : 'Play again'}
      </button>
      <p className="playagain__note">
        Same mode, same bans, same settings — and the same two seats.
      </p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
