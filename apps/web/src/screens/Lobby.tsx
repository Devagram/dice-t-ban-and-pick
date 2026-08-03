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

  useEffect(() => {
    fetchPreview(roomCode)
      .then(setPreview)
      .catch((e: Error) => setError(e.message))
  }, [roomCode])

  const sit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const claimed = await claimSeat(roomCode)
      // D17 — stored before navigating, so a refresh one second later is already a non-event.
      rememberSeat(roomCode, {
        seatToken: claimed.seatToken,
        websocketUrl: claimed.websocketUrl,
      })
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
      ) : (
        <div className="seatcta">
          {/*
            D28 — asked here, not only on the home screen.
            
            A joiner arrives at /j/CODE and never sees the host's form, so this was the one seat
            that could never be named: the id still generated and the rule still worked, but the
            opponent saw a blank label. Sitting down is also the honest moment to ask — it is when
            you become a player rather than a visitor.
          */}
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
              Shown to your opponent, used to remember which ban you brought last time, and how the
              leaderboard knows you. Kept in this browser only — losing the browser loses the name.
            </p>
          </label>

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
            disabled={busy || name.trim().length === 0 || nameError !== null}
            onClick={sit}
          >
            Take a seat
          </button>
          {name.trim().length === 0 ? (
            <p className="seatcta__note seatcta__note--blocking">Enter your name to sit down.</p>
          ) : null}
        </div>
      )}

      <ShareRow roomCode={preview.roomCode} />

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
