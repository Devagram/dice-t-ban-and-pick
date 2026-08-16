import { useEffect, useState } from 'react'
import type { Action, PlayerActionPayload, PlayerView, RoundOutcome } from '@banpick/types'

import { DRAW_HEADLINE, DRAW_NOTE, FROZEN_NOTE } from '../copy.js'
import { play } from '../sound.js'

/**
 * Three rounds, and where the match stands.
 *
 * The privilege sequence is worth showing rather than hiding, because it is not obvious and it
 * is not the same every round (D10/D11): round 0 is chosen, round 1 is the exact inversion of
 * it with no roll at all, and round 2 rolls fresh for turn order with no draft privilege in
 * existence. A player who cannot see that will think round 1's missing roll is a bug.
 */
export function RoundStrip({
  view,
  onAct,
}: {
  view: PlayerView
  /** Omitted where the strip is read-only. Given, each played round becomes correctable (D33). */
  onAct?: (payload: PlayerActionPayload) => void
}) {
  const started = view.phase?.roundIndex ?? null
  const [amending, setAmending] = useState<number | null>(null)
  const amend = view.legalActions.find((a) => a.type === 'AMEND_RESULT')

  /**
   * Nothing until the rounds actually start.
   *
   * `roundIndex` is `null` for every pre-round module — the ban, the draft, the reveal — and a
   * number from the first roll onward, so it answers "has the game begun?" without the client
   * knowing anything about the program. Three empty R1/R2/R3 boxes during the draft are a
   * promise about later competing with the thing you are doing now.
   *
   * A completed match keeps its strip: by then it is the scoreline, which is the one thing worth
   * reading on that screen.
   */
  if (started === null && view.status !== 'COMPLETE') return null

  return (
    <>
      {/*
       * D39 — why the correction controls are gone.
       *
       * Rendered from `view.frozen`, which carries the server's reason rather than a bare flag: a
       * control that silently stops appearing is worse than one that explains itself, and the
       * client must not be the thing inventing the explanation. Sits above the strip because the
       * strip is exactly where somebody looks for the "fix that" button it is accounting for.
       */}
      {view.frozen ? (
        <p className="rounds__frozen" role="status">
          {FROZEN_NOTE}
        </p>
      ) : null}
      <RoundPips
        view={view}
        amending={amending}
        setAmending={setAmending}
        amend={amend}
        onAct={onAct}
      />
    </>
  )
}

function RoundPips({
  view,
  amending,
  setAmending,
  amend,
  onAct,
}: {
  view: PlayerView
  amending: number | null
  setAmending: (index: number | null) => void
  amend: Extract<Action, { type: 'AMEND_RESULT' }> | undefined
  onAct: ((payload: PlayerActionPayload) => void) | undefined
}) {
  const current = view.phase?.roundIndex ?? null

  return (
    <ol className="rounds" aria-label="Rounds">
      {view.rounds.map((round) => {
        const state = round.result !== null ? 'done' : round.index === current ? 'now' : 'later'
        return (
          <li
            key={round.index}
            className={`round round--${state}${round.overtime ? ' round--overtime' : ''}`}
          >
            {/* D30 — "OT" rather than "R4", because it is not the fourth round of anything. It
                only exists when regulation could not separate you. */}
            <span className="round__index">{round.overtime ? 'OT' : `R${round.index + 1}`}</span>
            <span className="round__detail">
              {round.result !== null && amending === round.index ? (
                <AmendPrompt
                  view={view}
                  options={amend?.rounds.find((r) => r.roundIndex === round.index)?.outcomes ?? []}
                  onPick={(outcome) => {
                    onAct?.({
                      type: 'AMEND_RESULT',
                      roundIndex: round.index,
                      outcome,
                      amendedBy: view.seat,
                    })
                    setAmending(null)
                  }}
                  onCancel={() => setAmending(null)}
                />
              ) : round.result !== null ? (
                <ResultLabel
                  view={view}
                  result={round.result}
                  {...(onAct && amend?.rounds.some((r) => r.roundIndex === round.index)
                    ? { onCorrect: () => setAmending(round.index) }
                    : {})}
                />
              ) : round.overtime && round.index !== current ? (
                // Conditional until it happens, and saying so beats a blank pip nobody can
                // place. The engine has already dropped it entirely where it cannot be reached.
                <span className="round__conditional">if level</span>
              ) : (
                <PrivilegeLabel view={view} round={round} />
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ResultLabel({
  view,
  result,
  onCorrect,
}: {
  view: PlayerView
  result: 'A' | 'B' | 'TIE'
  onCorrect?: () => void
}) {
  const label = result === 'TIE' ? 'Tied' : result === view.seat ? 'You won' : 'They won'
  const className = result === 'TIE' ? 'round__tie' : undefined

  // Read-only where there is nothing to correct with — the strip is also rendered without a way
  // to act, and a button that does nothing is worse than text.
  if (!onCorrect) return <span className={className}>{label}</span>

  return (
    <button type="button" className={`round__result ${className ?? ''}`} onClick={onCorrect}>
      {label}
      <span className="round__fix" aria-hidden="true">
        fix
      </span>
      <span className="sr-only">— correct this result</span>
    </button>
  )
}

/**
 * D33 — the correction itself, in the round it belongs to.
 *
 * Ordered the same way the live report is (D32's fix): your own win first, then theirs, then the
 * tie. The same position meaning the same thing in both places is the whole point — someone
 * correcting a misreport should not be handed a second chance to misreport it.
 */
function AmendPrompt({
  view,
  options,
  onPick,
  onCancel,
}: {
  view: PlayerView
  options: RoundOutcome[]
  onPick: (outcome: RoundOutcome) => void
  onCancel: () => void
}) {
  const opponent = view.seat === 'A' ? 'B' : 'A'
  const rank = (o: RoundOutcome) => (o === view.seat ? 0 : o === opponent ? 1 : 2)
  const ordered = [...options].sort((x, y) => rank(x) - rank(y))

  return (
    <span className="amend">
      {ordered.map((outcome) => (
        <button
          key={outcome}
          type="button"
          className="amend__btn amend__option"
          onClick={() => onPick(outcome)}
        >
          {outcome === 'TIE' ? 'Tie' : outcome === view.seat ? 'I won' : 'They won'}
        </button>
      ))}
      <button type="button" className="amend__btn amend__cancel" onClick={onCancel}>
        Cancel
      </button>
    </span>
  )
}

function PrivilegeLabel({
  view,
  round,
}: {
  view: PlayerView
  round: PlayerView['rounds'][number]
}) {
  const parts: string[] = []
  if (round.privilegeHolder) {
    parts.push(round.privilegeHolder === view.seat ? 'you ban' : 'they ban')
  }
  if (round.turnOrderHolder) {
    parts.push(round.turnOrderHolder === view.seat ? 'you set order' : 'they set order')
  }
  /*
   * D36 — who actually plays first, where nobody was given the right to decide it.
   *
   * `playOrder` has been on the view since D24 and the client never rendered it: in the Bo3 modes
   * the *decision* is the interesting part and it arrives as an action, so the outcome was
   * implicit in having just made it. A mode where the dice settle it has no such moment, and
   * without this the strip could only say "—" about the one fact the round had established.
   *
   * Shown only when nothing above it was, so the Bo3 strip reads exactly as it did.
   */
  if (parts.length === 0 && round.playOrder) {
    parts.push(round.playOrder.first === view.seat ? 'you play first' : 'they play first')
  }

  if (parts.length === 0) return <span>—</span>
  return <span>{parts.join(' · ')}</span>
}

/**
 * The terminal state, including the one that is easy to forget.
 *
 * D21: *"a 1.5–1.5 draw is a legal terminal state: the match is a draw"*, and the delivery plan
 * asks for it to be designed rather than bolted on — at a 5% per-round tie rate roughly 7% of
 * matches end this way, which is often enough that a player will meet it.
 */
export function Outcome({ view }: { view: PlayerView }) {
  /**
   * The result speaks last.
   *
   * The board tells the story first — the losing side recedes, the winner's cards rise and hold
   * gold — and this arrives after that has played. Announcing the winner on the same frame the
   * cards start moving would answer the question the sequence is asking, in the same way showing
   * the ban buttons under a still-tumbling die once did.
   */
  useEffect(() => {
    if (view.status !== 'COMPLETE' || view.outcome === null) return
    play(view.outcome === 'DRAW' ? 'reveal' : view.outcome === view.seat ? 'win' : 'lose')
  }, [view.status, view.outcome, view.seat])

  if (view.status !== 'COMPLETE' || view.outcome === null) return null

  if (view.outcome === 'DRAW') {
    return (
      <section className="outcome outcome--draw">
        <h2 className="outcome__headline">{DRAW_HEADLINE}</h2>
        <p className="outcome__note">{DRAW_NOTE}</p>
        <Score view={view} />
      </section>
    )
  }

  const won = view.outcome === view.seat
  return (
    <section className={`outcome ${won ? 'outcome--won' : 'outcome--lost'}`}>
      <h2 className="outcome__headline">{won ? 'You win the match' : 'They win the match'}</h2>
      <Score view={view} />
    </section>
  )
}

function Score({ view }: { view: PlayerView }) {
  return (
    <p className="outcome__score">
      <strong>{formatScore(view.you.score)}</strong>
      <span aria-hidden="true"> — </span>
      <strong>{formatScore(view.opponent.score)}</strong>
      <span className="outcome__scorenote">you / them</span>
    </p>
  )
}

/** HALF_POINT scoring (D21) means halves are ordinary, so they are rendered as halves. */
function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}
