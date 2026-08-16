import type { BracketSlot, TournamentView } from '../api.js'

/**
 * **D37 — the bracket, drawn.**
 *
 * Inline SVG, and the layout is a **pure function of the bracket**: every coordinate falls out of
 * `(side, round, match)` and the entrant count. No measurement pass, no ref, no library. That is
 * not minimalism for its own sake — a layout that measures cannot be tested without a renderer
 * that lays out, and the sizing case here (32 entrants) is exactly the one nobody would check by
 * hand.
 *
 * **The accessible version is not a fallback.** The `<ol>` below the drawing is the same bracket
 * as a list of rounds, always present: it is what a screen reader reads, what a printer prints,
 * and what survives a browser that will not do SVG. The drawing is `aria-hidden` precisely so
 * they are never read twice.
 */

/** Box and pitch, in SVG units. Fixed, because everything else is derived from them. */
const BOX_W = 172
const BOX_H = 44
const COL_GAP = 44
const ROW_H = 56
const PAD = 16

const COL_W = BOX_W + COL_GAP

interface Placed {
  entry: BracketSlot
  x: number
  y: number
}

/**
 * Where every slot sits.
 *
 * Winners occupy a band across the top; losers a band beneath it; the grand final sits to the
 * right of both, vertically between them. Within a band, a round's matches are spread evenly over
 * the band's height — which reproduces the classic doubling-gap tree without anybody having to
 * compute midpoints, because a round with half as many matches gets twice the spacing by
 * construction.
 */
function layout(view: TournamentView): { placed: Placed[]; width: number; height: number } {
  const winners = view.slots.filter((s) => s.slot.side === 'WINNERS')
  const losers = view.slots.filter((s) => s.slot.side === 'LOSERS')
  const finals = view.slots.filter((s) => s.slot.side === 'GRAND_FINAL')

  const countIn = (list: BracketSlot[], round: number): number =>
    list.filter((s) => s.slot.round === round).length

  const winnerRounds = Math.max(0, ...winners.map((s) => s.slot.round))
  const loserRounds = Math.max(0, ...losers.map((s) => s.slot.round))

  const firstWinners = countIn(winners, 1) || 1
  const winnersBand = firstWinners * ROW_H
  const firstLosers = countIn(losers, 1) || 0
  // Losers round one holds half of winners round one, and its pairs sit twice as far apart.
  const losersBand = firstLosers * ROW_H * 2

  const bandGap = losers.length > 0 ? ROW_H : 0
  const place = (
    list: BracketSlot[],
    round: number,
    match: number,
    band: number,
    top: number,
  ): number => {
    const n = countIn(list, round) || 1
    const spacing = band / n
    return top + (match - 0.5) * spacing - BOX_H / 2
  }

  const placed: Placed[] = [
    ...winners.map((entry) => ({
      entry,
      x: PAD + (entry.slot.round - 1) * COL_W,
      y: PAD + place(winners, entry.slot.round, entry.slot.match, winnersBand, 0),
    })),
    ...losers.map((entry) => ({
      entry,
      x: PAD + (entry.slot.round - 1) * COL_W,
      y: PAD + place(losers, entry.slot.round, entry.slot.match, losersBand, winnersBand + bandGap),
    })),
  ]

  // The finals sit past whichever bracket runs longer, stacked if D40's reset is in play.
  const finalsColumn = Math.max(winnerRounds, loserRounds)
  for (const [i, entry] of finals.entries()) {
    placed.push({
      entry,
      x: PAD + finalsColumn * COL_W,
      y: PAD + winnersBand + bandGap / 2 - BOX_H / 2 + i * ROW_H * 1.5,
    })
  }

  const width = PAD * 2 + (finalsColumn + 1) * COL_W - COL_GAP
  const height = PAD * 2 + winnersBand + bandGap + losersBand
  return { placed, width, height }
}

/**
 * The winner's path, drawn as an elbow.
 *
 * **Loser paths are deliberately not drawn.** Every winners slot also feeds a losers slot, and
 * those lines cross the entire diagram — eight of them at sixteen entrants. Drawn, they turn the
 * one thing a bracket is for (following a name forwards) into a puzzle. Where somebody fell to is
 * legible from the losers bracket itself, which is the half of the picture that answers it.
 */
function connectors(placed: Placed[]): { from: Placed; to: Placed }[] {
  const byId = new Map(placed.map((p) => [p.entry.slot.id, p]))
  return placed.flatMap((from) => {
    const target = from.entry.slot.winnerTo
    const to = target ? byId.get(target) : undefined
    return to ? [{ from, to }] : []
  })
}

/** Names are truncated by character count, not by measuring — see the note at the top. */
const short = (name: string, max = 18): string =>
  name.length <= max ? name : `${name.slice(0, max - 1)}…`

export function Bracket({
  view,
  youArePlayerId,
}: {
  view: TournamentView
  /** Highlights the viewer's own match. Omitted for a pure spectator. */
  youArePlayerId?: string
}) {
  const { placed, width, height } = layout(view)
  const byEntrant = new Map(view.entrants.map((e) => [e.entrantId, e]))
  const yourEntrantId = view.entrants.find((e) => e.playerId === youArePlayerId)?.entrantId

  const nameOf = (entrantId: string | null, entry: BracketSlot, side: 0 | 1): string => {
    if (entrantId) return short(byEntrant.get(entrantId)?.displayName ?? entrantId)
    // An unknown side names where its occupant will come from, which is the thing a reader is
    // actually asking when they look at an empty box.
    const ref = entry.slot.id
    return entry.status === 'BYE' ? 'bye' : `winner of ${feederOf(view, ref, side) ?? '…'}`
  }

  return (
    <div className="bracket">
      {/*
       * Scrolls inside its own box. 32 entrants is ~1400 units wide and the page body must never
       * scroll sideways — a horizontal scrollbar on the document is how a bracket makes every
       * other screen feel broken on a phone.
       */}
      <div className="bracket__scroll">
        <svg
          className="bracket__svg"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="presentation"
          aria-hidden="true"
        >
          {connectors(placed).map(({ from, to }) => {
            const x1 = from.x + BOX_W
            const y1 = from.y + BOX_H / 2
            const x2 = to.x
            const y2 = to.y + BOX_H / 2
            const mid = x1 + (x2 - x1) / 2
            return (
              <path
                key={`${from.entry.slot.id}->${to.entry.slot.id}`}
                className="bracket__link"
                d={`M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`}
                fill="none"
              />
            )
          })}

          {placed.map(({ entry, x, y }) => {
            const mine = yourEntrantId !== undefined && entry.entrants.includes(yourEntrantId)
            return (
              <g
                key={entry.slot.id}
                // Stable handle for tests and for anybody debugging a layout against the DOM. The
                // visible label is not one: D40's reset reads "reset", not "GF2".
                data-slot={entry.slot.id}
                className={`bslot bslot--${entry.status.toLowerCase()} ${mine ? 'bslot--mine' : ''}`}
                transform={`translate(${x} ${y})`}
              >
                <rect className="bslot__box" width={BOX_W} height={BOX_H} rx="6" />
                <line className="bslot__split" x1="0" y1={BOX_H / 2} x2={BOX_W} y2={BOX_H / 2} />
                {([0, 1] as const).map((side) => {
                  const entrantId = entry.entrants[side]
                  const won = entry.winner !== null && entry.winner === entrantId
                  return (
                    <text
                      key={side}
                      className={`bslot__name ${won ? 'bslot__name--won' : ''} ${
                        entrantId === null ? 'bslot__name--tbd' : ''
                      }`}
                      x="8"
                      y={side * (BOX_H / 2) + BOX_H / 4 + 4}
                    >
                      {nameOf(entrantId, entry, side)}
                    </text>
                  )
                })}
                {/*
                 * The mode, on every slot, because it varies — a Bo1 losers bracket beside a Bo3
                 * winners bracket is the feature, and a drawing that does not say which is which
                 * hides it.
                 */}
                <text className="bslot__meta" x={BOX_W - 8} y="-4" textAnchor="end">
                  {entry.slot.id === 'GF2' ? 'reset' : entry.slot.id} · {entry.modeId}
                </text>
                {entry.status !== 'PENDING' && entry.status !== 'READY' ? (
                  <text className="bslot__status" x="8" y="-4">
                    {STATUS_LABEL[entry.status]}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>

      <AccessibleBracket view={view} />
    </div>
  )
}

const STATUS_LABEL: Record<BracketSlot['status'], string> = {
  PENDING: 'waiting',
  READY: 'ready',
  LIVE: 'playing now',
  DONE: 'done',
  BYE: 'bye',
  // D38 and D39 — three different reasons a slot is stuck, and the organiser is being asked a
  // different question by each. Collapsing them into one word would ask the wrong one.
  DISPUTED: 'disputed',
  VOIDED: 'voided',
  DRAWN: 'drew — needs a decision',
}

/** Which slot feeds a side, for the "winner of W1M2" label on an unfilled box. */
function feederOf(view: TournamentView, slotId: string, side: 0 | 1): string | null {
  const feeders = view.slots.filter((s) => s.slot.winnerTo === slotId).map((s) => s.slot.id)
  return feeders[side] ?? feeders[0] ?? null
}

/**
 * The same bracket, as a list.
 *
 * Not a fallback and not a duplicate: this is the accessible rendering, and the SVG above is
 * `aria-hidden` so the two are never announced together. It is also what a printer gets, which is
 * the form an organiser is most likely to want on paper.
 */
function AccessibleBracket({ view }: { view: TournamentView }) {
  const byEntrant = new Map(view.entrants.map((e) => [e.entrantId, e.displayName]))
  const groups = new Map<string, BracketSlot[]>()
  for (const entry of view.slots) {
    const key =
      entry.slot.side === 'GRAND_FINAL'
        ? entry.slot.id === 'GF2'
          ? 'Grand final reset'
          : 'Grand final'
        : `${entry.slot.side === 'WINNERS' ? 'Winners' : 'Losers'} round ${entry.slot.round}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }

  return (
    <ol className="bracket__list" aria-label="Bracket">
      {[...groups].map(([round, entries]) => (
        <li key={round}>
          <h3>{round}</h3>
          <ol>
            {entries.map((entry) => (
              <li key={entry.slot.id}>
                {entry.slot.id}: {byEntrant.get(entry.entrants[0] ?? '') ?? 'to be decided'} versus{' '}
                {byEntrant.get(entry.entrants[1] ?? '') ?? 'to be decided'} — {entry.modeId},{' '}
                {STATUS_LABEL[entry.status]}
                {entry.winner ? `, won by ${byEntrant.get(entry.winner) ?? entry.winner}` : ''}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  )
}
