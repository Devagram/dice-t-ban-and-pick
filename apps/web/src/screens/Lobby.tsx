import { useEffect, useState } from 'react'
import type { LobbyPreview } from '@banpick/types'

import { claimSeat, fetchPreview } from '../api.js'
import { RulesetCard } from '../components/RulesetCard.js'
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
      <header className="matchbar">
        <span className="matchbar__room">{preview.roomCode}</span>
        <span className="matchbar__seat">
          {full ? 'Both seats taken' : `${preview.seatsAvailable.length} seat(s) open`}
        </span>
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
          <p className="seatcta__note">
            Taking a seat accepts these rules. The host cannot change them afterwards.
          </p>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={sit}>
            Take a seat
          </button>
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
