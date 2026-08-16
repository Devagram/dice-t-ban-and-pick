import { useEffect, useState } from 'react'
import type { LobbyPreview } from '@banpick/types'

import { claimName, claimSeat, fetchPreview } from '../api.js'
import { RulesetCard } from '../components/RulesetCard.js'
import { playerId, playerName, setPlayerName } from '../player.js'
import { rememberSeat } from '../transport.js'

/**
 * §12.3 — the joiner's screen. **Seating is the consent.**
 *
 * So the order on screen is the order of the decision: the whole ruleset first, the button that
 * accepts it last. There is no way to sit down without the rules having been rendered above the
 * fold you pressed.
 */
export function Lobby({
  roomCode,
  onSeated,
}: {
  roomCode: string
  onSeated: (seatToken: string, websocketUrl: string) => void
}) {
  const [preview, setPreview] = useState<LobbyPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(playerName)
  /** D29 — "somebody already uses that name" is an ordinary answer, shown beside the field. */
  const [nameError, setNameError] = useState<string | null>(null)
  /*
   * D41 — the entrant token, read once at mount.
   *
   * The tournament page links an entrant here as `/j/CODE#token`, in the fragment for the same
   * reason D17 puts a resume token there: a fragment is never sent to a server and never reaches
   * a request log. Read into state rather than off `location` at click time so that stripping it
   * from the address bar afterwards cannot take it away from a retry.
   */
  const [entrantToken] = useState(() => location.hash.replace(/^#/, ''))

  useEffect(() => {
    fetchPreview(roomCode)
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
  }, [roomCode])

  const sit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const claimed = await claimSeat(roomCode, entrantToken)
      // D17 — stored before navigating, so a refresh one second later is already a non-event.
      rememberSeat(roomCode, {
        seatToken: claimed.seatToken,
        websocketUrl: claimed.websocketUrl,
      })
      // Seated, so the entrant token has done its job and the seat token has taken over. Removed
      // from the address bar exactly as a resume link's is: it opens this seat for the length of
      // the event, and a screenshot should not hand that over.
      if (entrantToken) history.replaceState(null, '', `/j/${roomCode}`)
      onSeated(claimed.seatToken, claimed.websocketUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (error && !preview) {
    return (
      <main className="screen screen--centred">
        <h1 className="title">Room {roomCode}</h1>
        <p className="alert" role="alert">
          {error}
        </p>
        <a className="btn" href="/">
          Start again
        </a>
      </main>
    )
  }

  if (!preview) {
    return (
      <main className="screen screen--centred">
        <p className="muted">Loading room {roomCode}…</p>
      </main>
    )
  }

  const full = preview.seatsAvailable.length === 0
  /*
   * D41 — a bracket match somebody arrived at without their link.
   *
   * The server refuses this seat and is right to: only the two entrants the bracket named may sit
   * here. What was wrong was finding out afterwards — the lobby asked for a name, offered a seat,
   * and turned it into a 403 on the click. Said up front instead, with the bracket to go and look
   * at, because a spectator following a room code is the ordinary case rather than an intruder.
   */
  const reserved = preview.tournament !== undefined && !entrantToken
  /*
   * Arriving with the link the organizer sent: the seat is already yours, and so is the name.
   *
   * The tournament seats you under your *registered* identity (D41) rather than whatever this
   * browser calls itself, so that the bracket and the leaderboard cannot end up describing two
   * different people. Asking for a name here would be collecting one the server discards.
   */
  const asEntrant = preview.tournament !== undefined && entrantToken !== ''

  return (
    <main className="screen">
      {/*
        The code is the whole reason this screen exists — it is what one person reads aloud to
        another. It gets the room, not a line in a bar.
      */}
      <header className="codehero">
        <p className="codehero__label">Room code</p>
        <p className="codehero__code">{preview.roomCode}</p>
        <p className={`codehero__seats ${full ? '' : 'codehero__seats--open'}`}>
          {full ? 'Both seats taken' : `Waiting — ${preview.seatsAvailable.length} of 2 seats open`}
        </p>
      </header>

      <RulesetCard
        modeLabel={preview.modeLabel}
        ruleset={preview.ruleset}
        globalBannedCharacters={preview.globalBannedCharacters}
        rosterSize={preview.roster.length}
      />

      {full ? (
        <p className="muted">
          This match already has two players. If one of them is you, open your resume link.
        </p>
      ) : reserved ? (
        <div className="seatcta">
          <p className="seatcta__note">
            This is a match in tournament {preview.tournament!.code} ({preview.tournament!.slotId}).
            Both seats are held for the two entrants the bracket named — open it from the link the
            organiser sent you, and you will be seated automatically.
          </p>
          <a className="btn btn--primary" href={`/t/${preview.tournament!.code}`}>
            See the bracket
          </a>
        </div>
      ) : (
        <div className="seatcta">
          {asEntrant ? (
            <p className="seatcta__note">
              Your seat in tournament {preview.tournament!.code} ({preview.tournament!.slotId}) is
              held for you, and you will be seated under the name you were entered as — nothing to
              fill in.
            </p>
          ) : (
            /*
              D28 — asked here, not only on the host's screen.

              A joiner arrives at /j/CODE and never sees the host's form, so this was the one seat
              that could never be named: the id still generated and the rule still worked, but the
              opponent saw a blank label. Sitting down is also the honest moment to ask — it is
              when you become a player rather than a visitor.
            */
            <label className="field">
              <span className="field__label">Your name</span>
              <input
                className="field__input"
                // Named explicitly: the wrapping label also holds the help paragraph, so the
                // computed accessible name would otherwise be "Your name" followed by a sentence
                // of explanation — technically labelled, useless to listen to.
                aria-label="Your name"
                value={name}
                placeholder="Tom"
                maxLength={40}
                onChange={(e) => {
                  setName(e.target.value)
                  setPlayerName(e.target.value)
                  setNameError(null)
                }}
                /*
                 * Claimed on blur rather than on every keystroke: the first browser to use a name
                 * owns it (D29), and claiming mid-typing would reserve "T", "To", "Tom" on the way
                 * past — locking three names out of a group of four people.
                 */
                onBlur={() => {
                  const trimmed = name.trim()
                  if (!trimmed) return
                  void claimName(playerId(), trimmed).then(setNameError)
                }}
              />
              {nameError ? (
                <p className="field__error" role="alert">
                  {nameError}
                </p>
              ) : null}
              <p className="field__help">
                Shown to your opponent, used to remember which ban you brought last time, and how
                the leaderboard knows you. Kept in this browser only — losing the browser loses the
                name.
              </p>
            </label>
          )}

          <p className="seatcta__note">
            Taking a seat accepts these rules. The host cannot change them afterwards.
          </p>
          {/*
            A name is required (D29).

            It stopped being decoration when it became a record: an unnamed seat leaves a match off
            the leaderboard entirely and gives the no-repeat-ban rule nothing to key on, so the game
            would silently behave differently for that player. Better to ask than be inconsistent.

            The button keeps its name while disabled rather than relabelling itself to explain — a
            control that renames itself is one a screen reader announces as a different control, and
            the reason belongs beside the field you have to fix, not on the thing you cannot press.
          */}
          <button
            type="button"
            className="btn btn--primary"
            // An entrant is exempt: the name is the tournament's to supply, so demanding one here
            // would block a seat on a field whose value the server is about to throw away.
            disabled={busy || (!asEntrant && (name.trim().length === 0 || nameError !== null))}
            onClick={sit}
          >
            Take a seat
          </button>
          {!asEntrant && name.trim().length === 0 ? (
            <p className="seatcta__note seatcta__note--blocking">Enter your name to sit down.</p>
          ) : null}
        </div>
      )}

      {/*
       * No invite for a bracket match. The room code opens nothing for anyone but the two
       * entrants (D41), so offering a link to send would be offering a link that refuses whoever
       * receives it.
       */}
      {preview.tournament ? null : <ShareRow roomCode={preview.roomCode} />}

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  )
}

/** D20 — the join URL carries the room code and nothing else. */
function ShareRow({ roomCode }: { roomCode: string }) {
  const url = `${location.origin}/j/${roomCode}`
  return (
    <section className="panel">
      <h2 className="panel__title">Invite the other player</h2>
      <input
        className="resume__url"
        readOnly
        value={url}
        aria-label="Invite link"
        onFocus={(e) => e.currentTarget.select()}
      />
      <p className="field__help">Or read them the code: {roomCode}</p>
    </section>
  )
}
