import type { PlayerView } from '@banpick/types'

/**
 * What the opponent is doing, right now.
 *
 * The complaint this answers: *"rather than just blindly proceeding and having no indication of
 * progress."* Two different signals, from two different places, and it matters which is which:
 *
 *   - **Whose turn it is** comes from `phase.awaiting`, which the server computes. It is
 *     authoritative and always correct.
 *   - **How far through a hidden draft they are** comes from the opponent's own client, relayed
 *     as a bare count. The server cannot know it — a draft is one `COMMIT` carrying every pick
 *     at once, so until it lands there is nothing on the server to report.
 *
 * The second is unverifiable and deliberately so. It carries a number and never a character
 * (§7), it is never logged, and the worst a dishonest client achieves is a wrong progress bar.
 */

export interface OpponentActivityProps {
  view: PlayerView
  /** Latest relayed count, or `null` if they have not reported since the last state change. */
  progress: { filled: number; of: number } | null
}

export function OpponentActivity({ view, progress }: OpponentActivityProps) {
  if (view.status !== 'IN_PROGRESS') return null

  const opponentSeat = view.seat === 'A' ? 'B' : 'A'
  const waitingOnThem = view.phase?.awaiting.includes(opponentSeat) ?? false
  const waitingOnYou = view.phase?.awaiting.includes(view.seat) ?? false

  if (!waitingOnThem) return null

  const drafting = view.legalActions.some((a) => a.type === 'COMMIT' || a.type === 'RECOMMIT')
  const showBar = progress !== null && progress.of > 0

  return (
    <section
      className={`activity ${view.opponent.hasCommitted ? 'activity--done' : ''}`}
      aria-live="polite"
    >
      <span className="activity__dot" aria-hidden="true" />
      <div className="activity__body">
        <p className="activity__text">
          {view.opponent.hasCommitted
            ? 'They have sealed their choice.'
            : showBar
              ? `They have chosen ${progress.filled} of ${progress.of}.`
              : waitingOnYou
                ? 'They are still deciding too.'
                : describe(view)}
        </p>

        {showBar && !view.opponent.hasCommitted ? (
          <div
            className="activity__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.of}
            aria-valuenow={progress.filled}
            aria-label="Opponent draft progress"
          >
            {Array.from({ length: progress.of }, (_, i) => (
              <span
                key={i}
                className={`activity__pip ${i < progress.filled ? 'activity__pip--on' : ''}`}
              />
            ))}
          </div>
        ) : null}

        {drafting && !showBar && !view.opponent.hasCommitted ? (
          <p className="activity__hint">You will not see what they pick until the reveal.</p>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Names the decision they are on, from the module the server says is current.
 *
 * Reads the phase rather than the round number, because the phases differ per round — round 1
 * has no roll at all (D10) and round 2 has no ban (D11), so anything derived from "which round
 * is it" would be wrong a third of the time.
 */
function describe(view: PlayerView): string {
  const type = view.phase?.type
  switch (type) {
    case 'SIMULTANEOUS_COMMIT':
      return 'They are drafting.'
    case 'CONDITIONAL_RECOMMIT':
      return 'Their ban landed — they are picking a replacement.'
    case 'BAN':
      return 'They are choosing which of your characters to ban.'
    case 'SELECT':
      return 'They are choosing who to play.'
    case 'CHOOSE':
      return 'They are deciding.'
    case 'REPORT_RESULT':
      return 'Waiting on the result of the round.'
    default:
      return 'Waiting for them.'
  }
}
