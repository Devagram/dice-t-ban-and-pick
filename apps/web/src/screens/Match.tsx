import { useEffect, useMemo, useState } from 'react'
import type { PlayerActionPayload, PlayerView, SlotIdx } from '@banpick/types'

import { RESUME_LINK_WARNING, WAITING_NOTE } from '../copy.js'
import { connect, type Transport, type TransportState } from '../transport.js'
import { ActionBar, slotTargets } from '../components/ActionBar.js'
import { DiceRoll } from '../components/DiceRoll.js'
import { OpponentActivity } from '../components/OpponentActivity.js'
import { DraftPanel, RecommitPanel } from '../components/DraftPanel.js'
import { Outcome, RoundStrip } from '../components/RoundStrip.js'
import { SlotRail } from '../components/SlotRail.js'

/**
 * The match.
 *
 * Everything on screen is a function of one `PlayerView`. There is no local game state, no
 * optimistic update, and no client-side legality — §11.4 and D18 between them mean the client
 * *cannot* have an opinion, and this screen is where that would otherwise be tempting.
 */
export function Match({
  roomCode,
  seatToken,
  websocketUrl,
}: {
  roomCode: string
  seatToken: string
  websocketUrl: string
}) {
  const [state, setState] = useState<TransportState>({
    status: 'connecting',
    view: null,
    rejection: null,
    error: null,
    progress: null,
  })
  const [transport, setTransport] = useState<Transport | null>(null)

  useEffect(() => {
    const t = connect(websocketUrl, seatToken, (patch) => setState((s) => ({ ...s, ...patch })))
    setTransport(t)
    return () => t.close()
  }, [websocketUrl, seatToken])

  const act = (payload: PlayerActionPayload): void => transport?.send(payload)

  if (!state.view) {
    return (
      <main className="screen screen--centred">
        <ConnectionBanner status={state.status} />
        <p className="muted">Joining match {roomCode}…</p>
      </main>
    )
  }

  return (
    <main className="screen">
      <ConnectionBanner status={state.status} />
      <MatchBody
        view={state.view}
        onAct={act}
        onProgress={(filled, of) => transport?.reportProgress(filled, of)}
        progress={state.progress}
        roomCode={roomCode}
        seatToken={seatToken}
      />
      {state.rejection ? (
        <p className="alert" role="alert">
          That did not go through: {state.rejection.detail}
        </p>
      ) : null}
      {state.error ? (
        <p className="alert" role="alert">
          {state.error.detail}
        </p>
      ) : null}
    </main>
  )
}

function MatchBody({
  view,
  onAct,
  onProgress,
  progress,
  roomCode,
  seatToken,
}: {
  view: PlayerView
  onAct: (payload: PlayerActionPayload) => void
  onProgress: (filled: number, of: number) => void
  progress: { filled: number; of: number } | null
  roomCode: string
  seatToken: string
}) {
  const targets = useMemo(() => slotTargets(view), [view])
  const commit = view.legalActions.find((a) => a.type === 'COMMIT')
  const recommit = view.legalActions.find((a) => a.type === 'RECOMMIT')

  // The round's roll, shown once per round. Keyed by round so the animation replays when a new
  // round rolls and *not* when some unrelated frame arrives — a die that re-tumbles every time
  // the opponent moves would be maddening.
  const round = view.phase?.roundIndex ?? null
  const roll = round !== null ? (view.rounds[round]?.roll ?? null) : null
  const [rollSeen, setRollSeen] = useState<number | null>(null)
  const rollPlaying = roll !== null && round !== null && rollSeen !== round

  // "Are we waiting on me?" is answered by the server: `awaiting` names the seats a module is
  // blocked on. The undo is excluded because it is a standing offer, not a turn.
  const myMove = view.legalActions.some((a) => a.type !== 'UNDO_LAST_RESULT')
  const waiting = !myMove && view.status === 'IN_PROGRESS'

  return (
    <>
      <header className="matchbar">
        <span className="matchbar__room">{roomCode}</span>
        <span className="matchbar__seat">You are seat {view.seat}</span>
        <ResumeLink roomCode={roomCode} seatToken={seatToken} />
      </header>

      <Outcome view={view} />
      <RoundStrip view={view} />

      {roll && round !== null ? (
        <DiceRoll key={`roll-${round}`} view={view} roll={roll} onDone={() => setRollSeen(round)} />
      ) : null}

      {/* The rest of the round waits for the dice to land. Showing the ban buttons under a
          still-tumbling die would answer the question the animation is asking. */}
      {rollPlaying ? null : (
        <>
          <OpponentActivity view={view} progress={progress} />
          {commit ? (
            <DraftPanel view={view} commit={commit} onAct={onAct} onProgress={onProgress} />
          ) : null}
          {recommit ? <RecommitPanel view={view} recommit={recommit} onAct={onAct} /> : null}
        </>
      )}

      {rollPlaying || commit || recommit ? null : (
        <>
          {targets.ban ? (
            <p className="prompt__title">Ban one of their characters for this round</p>
          ) : null}
          {targets.select ? <p className="prompt__title">Choose who you play this round</p> : null}

          <div className="rails">
            <SlotRail
              title="Yours"
              view={view.you}
              roster={view.roster}
              currentRound={view.phase?.roundIndex ?? null}
              selectable={targets.own as SlotIdx[]}
              onSelect={(index) => {
                const select = targets.select
                if (!select) return
                onAct({
                  type: 'SELECT',
                  moduleId: select.moduleId,
                  roundIndex: select.roundIndex,
                  seat: view.seat,
                  slotIndex: index,
                  reason: null,
                })
              }}
            />
            <SlotRail
              title="Theirs"
              view={view.opponent}
              roster={view.roster}
              currentRound={view.phase?.roundIndex ?? null}
              selectable={targets.opponent as SlotIdx[]}
              onSelect={(index) => {
                const ban = targets.ban
                if (!ban) return
                const target = ban.targets.find((t) => t.slotIndex === index)
                if (!target) return
                onAct({
                  type: 'BAN',
                  moduleId: ban.moduleId,
                  roundIndex: ban.roundIndex,
                  seat: view.seat,
                  tier: 'ROUND',
                  target,
                })
              }}
            />
          </div>
        </>
      )}

      <ActionBar view={view} onAct={onAct} />

      {waiting ? (
        <p className="muted" aria-live="polite">
          {WAITING_NOTE}
        </p>
      ) : null}
    </>
  )
}

/**
 * D17 — "the same token is embedded in a resume link, surfaced in the UI as copyable. That link
 * is what makes device change work, and what rescues a cleared cache."
 *
 * Behind a disclosure rather than on screen, because it is a bearer credential and the warning
 * has to arrive at the same moment the link does.
 */
function ResumeLink({ roomCode, seatToken }: { roomCode: string; seatToken: string }) {
  const [open, setOpen] = useState(false)
  const url = `${location.origin}/r/${roomCode}#${seatToken}`

  return (
    <details className="resume" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="resume__summary">Play on another device</summary>
      <p className="resume__warning">{RESUME_LINK_WARNING}</p>
      <input
        className="resume__url"
        readOnly
        value={url}
        aria-label="Resume link"
        onFocus={(e) => e.currentTarget.select()}
      />
    </details>
  )
}

/** D17 makes a disconnect a non-event, so this says so rather than raising an alarm. */
function ConnectionBanner({ status }: { status: TransportState['status'] }) {
  if (status === 'open') return null

  return (
    <p className={`conn conn--${status}`} role="status" aria-live="polite">
      {status === 'connecting'
        ? 'Connecting…'
        : status === 'reconnecting'
          ? 'Reconnecting — nothing is lost.'
          : 'Disconnected.'}
    </p>
  )
}
