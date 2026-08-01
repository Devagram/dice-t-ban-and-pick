import { useEffect, useRef, useState } from 'react'
import type { PlayerView } from '@banpick/types'

/**
 * A card that names the phase you have just entered, briefly.
 *
 * This is polish, but it answers a real problem rather than decorating one. The server resolves
 * several modules into a single frame — committing a draft fires the reveal, which opens round
 * one, which offers the roll — so the board can go from "choose four characters" to "round one,
 * ban something" between two renders, with nothing in between to mark that anything happened.
 *
 * Naming the phase costs a second and makes the sequence legible.
 *
 * The label is derived from `phase.type` and `roundIndex`, never from the module id: ids are mode
 * config (`ban`, `draft`, `rounds.0.ban`) and a client reading them would be knowing something
 * about the mode file, which is exactly the coupling D18 exists to prevent.
 */

const HOLD_MS = 1400

export function titleFor(view: PlayerView): string | null {
  const phase = view.phase
  if (!phase || view.status !== 'IN_PROGRESS') return null

  const round = phase.roundIndex
  if (round !== null) {
    switch (phase.type) {
      case 'ROLL':
        return `Round ${round + 1} — roll for priority`
      case 'BAN':
        return `Round ${round + 1} — ban`
      case 'SELECT':
        return `Round ${round + 1} — choose your fighter`
      case 'REPORT_RESULT':
        return `Round ${round + 1} — play it out`
      default:
        return `Round ${round + 1}`
    }
  }

  // Before the rounds: the ban phase, the draft, and the reveal between them.
  switch (phase.type) {
    case 'SIMULTANEOUS_COMMIT':
      // A commit that wants a ban and no picks is the ban phase; the other is the draft. Read
      // off the offered action rather than the module id, for the reason in the header.
      return view.legalActions.some((a) => a.type === 'COMMIT' && a.picks === null)
        ? 'Ban a character'
        : 'Draft your roster'
    case 'CONDITIONAL_RECOMMIT':
      return 'Replace what was banned'
    case 'REVEAL':
      return 'Reveal'
    default:
      return null
  }
}

export function PhaseTitle({ view }: { view: PlayerView }) {
  const title = titleFor(view)
  const seen = useRef<string | null>(title)
  const [showing, setShowing] = useState<string | null>(null)

  useEffect(() => {
    if (title === null || title === seen.current) return
    seen.current = title

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

    setShowing(title)
    const t = setTimeout(() => setShowing(null), HOLD_MS)
    return () => clearTimeout(t)
  }, [title])

  if (!showing) return null

  // `aria-hidden`: the phase is already announced by the live regions that describe what you can
  // do. This is a visual beat, and hearing it twice would be worse than not hearing it.
  return (
    <div className="phasetitle" aria-hidden="true">
      <span className="phasetitle__text">{showing}</span>
    </div>
  )
}
