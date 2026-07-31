import type { PlayerView } from '@banpick/types'

/**
 * What the opponent is doing, right now — in words.
 *
 * This used to carry the count as well ("They have chosen 2 of 4") plus a pip bar. Both are gone:
 * the board above now fills a slot as each pick lands, which says the same thing in the place
 * you are already looking. A number narrating a picture you can see is noise.
 *
 * What is left is the part the board cannot show — *which phase* they are in, and that you will
 * not see their picks until the reveal. That comes from `phase.awaiting`, which the server
 * computes and is therefore authoritative, unlike the relayed count that drives the board.
 */

export interface OpponentActivityProps {
  view: PlayerView
}

export function OpponentActivity({ view }: OpponentActivityProps) {
  if (view.status !== 'IN_PROGRESS') return null

  const opponentSeat = view.seat === 'A' ? 'B' : 'A'
  const waitingOnThem = view.phase?.awaiting.includes(opponentSeat) ?? false
  const waitingOnYou = view.phase?.awaiting.includes(view.seat) ?? false

  if (!waitingOnThem) return null

  const drafting = view.legalActions.some((a) => a.type === 'COMMIT' || a.type === 'RECOMMIT')

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
            : waitingOnYou
              ? 'They are still deciding too.'
              : describe(view)}
        </p>

        {drafting && !view.opponent.hasCommitted ? (
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
