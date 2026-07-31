import { useEffect, useMemo, useRef, useState } from 'react'
import type { CharId, PlayerActionPayload, PlayerView, SlotIdx } from '@banpick/types'

import { RESUME_LINK_WARNING, WAITING_NOTE } from '../copy.js'
import { connect, type Transport, type TransportState } from '../transport.js'
import { ActionBar, slotTargets } from '../components/ActionBar.js'
import { DiceRoll } from '../components/DiceRoll.js'
import { OpponentActivity } from '../components/OpponentActivity.js'
import { DraftPanel, RecommitPanel } from '../components/DraftPanel.js'
import { Outcome, RoundStrip } from '../components/RoundStrip.js'
import { Stage, revealDurationMs } from '../components/Stage.js'

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
    <main className="screen screen--wide">
      <ConnectionBanner status={state.status} />
      <MatchBody
        view={state.view}
        onAct={act}
        onProgress={(filled, of, ban) => transport?.reportProgress(filled, of, ban)}
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
  onProgress: (filled: number, of: number, ban: boolean) => void
  progress: { filled: number; of: number; ban: boolean } | null
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

  /**
   * Your own in-flight draft, so your rail fills as you pick.
   *
   * Held here rather than in `DraftPanel` because the rail outlives the panel: the picks have to
   * stay on screen from the first click through the commit. **Never sent** — the wire carries
   * counts only (§7); these are ids, and they are yours.
   */
  const [mine, setMine] = useState<{ picks: CharId[]; metaBan: CharId | null }>({
    picks: [],
    metaBan: null,
  })

  /**
   * A request to take one of your picks back, raised by clicking it on the board.
   *
   * Carries a counter as well as an id so that removing, re-picking, and removing the *same*
   * character again is still a distinct request — without it the second click is indistinguishable
   * from the first and `DraftPanel` would ignore it.
   */
  const [removeRequest, setRemoveRequest] = useState<{ id: CharId; n: number }>({ id: '', n: 0 })

  // Cleared once the commit lands, so the real slots take over from the local guess rather than
  // both being drawn.
  useEffect(() => {
    if (view.you.hasCommitted) setMine({ picks: [], metaBan: null })
  }, [view.you.hasCommitted])

  /**
   * How many boxes to draw before anything is committed.
   *
   * `draftCount` is a declared mode parameter (D25) and is on the public ruleset, so both rails
   * can be the right size from the moment the match opens — including the opponent's, whose
   * `slotCount` stays 0 until they commit.
   */
  const expectedSlots = Number(view.ruleset.parameters.draftCount) || 0

  /**
   * True for one beat when the opponent's draft opens, so the flip plays exactly once.
   *
   * Keyed on the *transition* rather than on the state: this component re-renders on every
   * frame, and a reveal that replayed each time would be unwatchable. Honours reduced motion by
   * never starting.
   */
  const opponentOpen = (view.opponent.slots?.length ?? 0) > 0
  const wasOpen = useRef(opponentOpen)
  const [revealing, setRevealing] = useState(false)

  useEffect(() => {
    if (opponentOpen === wasOpen.current) return
    wasOpen.current = opponentOpen
    if (!opponentOpen) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

    setRevealing(true)
    const done = setTimeout(() => setRevealing(false), revealDurationMs(expectedSlots))
    return () => clearTimeout(done)
  }, [opponentOpen, expectedSlots])

  return (
    <>
      <header className="matchbar">
        <span className="matchbar__room">{roomCode}</span>
        <span className="matchbar__seat">You are seat {view.seat}</span>
        <ResumeLink roomCode={roomCode} seatToken={seatToken} />
      </header>

      <Outcome view={view} />
      <RoundStrip view={view} />

      {/*
        The dice wait for the rosters.
        
        Both arrive in the *same* frame: committing fires `pickReveal`, which opens round one,
        which fires the ROLL — the server drains all of it in one settle and sends one view. So
        without this gate the roll starts on the frame the reveal does, and the reveal is never
        seen at all.
      */}
      {roll && round !== null && !revealing ? (
        <DiceRoll key={`roll-${round}`} view={view} roll={roll} onDone={() => setRollSeen(round)} />
      ) : null}

      {/* The board never leaves. It used to sit inside the roll gate below, which meant it was
          unmounted for the whole reveal — the one moment it most needs to be on screen. */}
      <Stage
        view={view}
        expected={expectedSlots}
        mine={{ filled: mine.picks.length, picks: mine.picks, ban: mine.metaBan !== null }}
        // Their count comes from their own browser, so the stage draws it as "choosing"
        // rather than as fact. No ids: there are none to have (§7).
        theirs={progress ? { filled: progress.filled, ban: progress.ban } : { filled: 0 }}
        revealing={revealing}
        selectableOwn={rollPlaying ? [] : (targets.own as SlotIdx[])}
        selectableOpponent={rollPlaying ? [] : (targets.opponent as SlotIdx[])}
        onSelectOwn={(index) => {
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
        onRemoveOwn={(id) => setRemoveRequest({ id, n: removeRequest.n + 1 })}
        onSelectOpponent={(index) => {
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

      {/* The controls wait for the dice, and for the reveal before them. Ban buttons under a
          still-tumbling die would answer the question the animation is asking. */}
      {rollPlaying || revealing ? null : (
        <>
          {/* The board, always in the same place and always the same shape. Only what sits
              *under* it changes: the roster while drafting, the result buttons once a round is
              being played. That fixed frame is the whole idea — a select screen you can read at
              a glance because nothing moves. */}
          {targets.ban ? (
            <p className="prompt__title">Ban one of their characters for this round</p>
          ) : null}
          {targets.select ? <p className="prompt__title">Choose who you play this round</p> : null}

          <OpponentActivity view={view} />

          {/* Under the board: the roster while there is drafting to do, and nothing at all once
              the rounds start — at which point the ActionBar's result buttons take its place. */}
          {commit ? (
            <DraftPanel
              // A fresh panel per commit phase. Without this the ban phase's selections carry
              // into the draft, because React reuses the instance when only the props change.
              key={commit.moduleId}
              view={view}
              commit={commit}
              onAct={onAct}
              onProgress={onProgress}
              onDraftChange={(picks, metaBan) => setMine({ picks, metaBan })}
              removeRequest={removeRequest}
            />
          ) : null}
          {recommit ? <RecommitPanel view={view} recommit={recommit} onAct={onAct} /> : null}
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
