import { useEffect } from 'react'
import type { PlayerView } from '@banpick/types'

import { DRAW_HEADLINE, DRAW_NOTE } from '../copy.js'
import { play } from '../sound.js'

/**
 * Three rounds, and where the match stands.
 *
 * The privilege sequence is worth showing rather than hiding, because it is not obvious and it
 * is not the same every round (D10/D11): round 0 is chosen, round 1 is the exact inversion of
 * it with no roll at all, and round 2 rolls fresh for turn order with no draft privilege in
 * existence. A player who cannot see that will think round 1's missing roll is a bug.
 */
export function RoundStrip({ view }: { view: PlayerView }) {
  const current = view.phase?.roundIndex ?? null

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
  if (current === null && view.status !== 'COMPLETE') return null

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
              {round.result !== null ? (
                <ResultLabel view={view} result={round.result} />
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

function ResultLabel({ view, result }: { view: PlayerView; result: 'A' | 'B' | 'TIE' }) {
  if (result === 'TIE') return <span className="round__tie">Tied</span>
  return <span>{result === view.seat ? 'You won' : 'They won'}</span>
}

function PrivilegeLabel({
  view,
  round,
}: {
  view: PlayerView
  round: PlayerView['rounds'][number]
}) {
  if (round.privilegeHolder === null && round.turnOrderHolder === null) return <span>—</span>

  const parts: string[] = []
  if (round.privilegeHolder) {
    parts.push(round.privilegeHolder === view.seat ? 'you ban' : 'they ban')
  }
  if (round.turnOrderHolder) {
    parts.push(round.turnOrderHolder === view.seat ? 'you set order' : 'they set order')
  }
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
