import { useState } from 'react'
import type { PlayerView } from '@banpick/types'

import { openRematch } from '../api.js'

/**
 * **D32 — play again, without building the match again.**
 *
 * A series was: go home, re-pick the mode, the parameters and the global bans, create, copy the
 * link, send it. Everything in that list is already known — it is the ruleset the finished match
 * is still holding — so this opens a room with the same terms and points both players at it.
 *
 * **It does not seat anyone.** The button gets you to the new room's join page and stops there.
 * Seating is consent (§12.3), and the fact that your opponent pressed a button is not consent on
 * your behalf, even when the ruleset is identical to the one you just played under. The cost is
 * one extra click; the alternative is the app agreeing to things for you.
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
  rematch: { roomCode: string; by: string } | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Only at the end, and only a real end: D15's undo reopens a completed match, and a rematch
  // offered over a match that is live again would be a room nobody is coming to.
  if (view.status !== 'COMPLETE') return null

  if (rematch) {
    const theirs = rematch.by !== view.seat
    return (
      <section className="playagain">
        <p className="playagain__note">
          {theirs
            ? `${view.opponent.player?.name || 'They'} opened a rematch — same rules.`
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
            .then((next) => {
              // Both seats get the same code from the server, so whoever pressed second is not
              // creating a second room — they are being handed the first one.
              location.assign(`/j/${next}`)
            })
            .catch(() => {
              setError('Could not open a rematch. The result is still recorded.')
              setBusy(false)
            })
        }}
      >
        {busy ? 'Opening…' : 'Play again'}
      </button>
      <p className="playagain__note">Same mode, same bans, same settings.</p>
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
