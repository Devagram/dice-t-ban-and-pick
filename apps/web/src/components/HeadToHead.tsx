import { useEffect, useState } from 'react'
import type { PlayerView } from '@banpick/types'

import { fetchHeadToHead, type HeadToHead as Record_ } from '../api.js'

/**
 * D29 — where you stand against the person opposite you.
 *
 * The overall table is the part you argue about; this is the part you feel. Shown only when both
 * seats are named, because a record against "Unnamed" is a record against nobody.
 *
 * `wins` from the endpoint is always wins for the id asked about first, so this asks about *you*
 * and reads the answer directly. One stored row, read from either side — A's "3–2 up" and B's
 * "2–3 down" cannot drift apart because they are the same row.
 */
export function HeadToHead({ view }: { view: PlayerView }) {
  const me = view.you.player
  const them = view.opponent.player
  const [record, setRecord] = useState<Record_ | null>(null)

  useEffect(() => {
    if (!me || !them) return
    let live = true
    fetchHeadToHead(me.id, them.id)
      .then((r) => {
        if (live) setRecord(r)
      })
      .catch(() => {
        // A missing record is not worth an error on a match screen — the line simply does not
        // appear, which is also what it does before anyone has played.
      })
    return () => {
      live = false
    }
    // Refetched when the match ends, so the line includes the match you just played.
  }, [me?.id, them?.id, view.status])

  if (!me || !them || !record) return null
  const played = record.wins + record.losses + record.draws
  if (played === 0) return null

  const verdict =
    record.wins > record.losses
      ? `You lead ${them.name || 'them'}`
      : record.wins < record.losses
        ? `${them.name || 'They'} leads you`
        : `Level with ${them.name || 'them'}`

  /*
   * Labelled, because unlabelled it gets read as the score of the match you are in.
   *
   * Reported as a bug: a brand-new room "says the score is already 1-0". Before the first round
   * this is the *only* thing on the screen carrying numbers — `Outcome`, `PlayAgain` and the
   * round strip all render nothing until there is something to show — and a bold "1–0" sitting
   * where a scoreline goes is a scoreline as far as anyone reading it is concerned. The verdict
   * beside it said "You lead Tom", which is only unambiguous once you already know what you are
   * looking at.
   */
  return (
    <p className="h2h" aria-label="Head to head record, all matches">
      <span className="h2h__tag">All-time</span>
      <span className="h2h__verdict">{verdict}</span>
      <span className="h2h__score">
        {record.wins}–{record.losses}
        {record.draws > 0 ? ` (${record.draws}D)` : ''}
      </span>
    </p>
  )
}
