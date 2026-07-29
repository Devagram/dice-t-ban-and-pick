import type { Character, RoundIdx, SeatView, SlotIdx } from '@banpick/types'

import { SEALED_NOTE } from '../copy.js'

/**
 * A seat's slots.
 *
 * Slots are an **ordered array, not a set** (§5) — they are the addressable ban target, and
 * with cross-seat mirrors allowed (D1) a character ID would not identify a unique one. So the
 * rail is positional, and position is the thing a player has to be able to point at.
 *
 * Three states matter and each has to read differently at a glance:
 *
 *   - **consumed** — played, gone, including on a tied round (D6)
 *   - **banned this round** — denied now, available again next round (D3)
 *   - **sealed** — the opponent has committed and you may not see it (§7)
 */

export interface SlotRailProps {
  view: SeatView
  roster: Character[]
  currentRound: RoundIdx | null
  /** Slots the server says are choosable right now. Empty when it is not this seat's move. */
  selectable?: SlotIdx[]
  onSelect?: (index: SlotIdx) => void
  title: string
}

export function SlotRail({
  view,
  roster,
  currentRound,
  selectable = [],
  onSelect,
  title,
}: SlotRailProps) {
  const byId = new Map(roster.map((c) => [c.id, c]))

  // §7: a hidden slice is *absent*, not null and not flagged. So the check is existence, and
  // the fallback renders the one public fact — that a commitment exists at all — which is what
  // makes "waiting for opponent" renderable without leaking what is being waited on.
  if (!view.slots) {
    return (
      <section className="rail" aria-label={title}>
        <h3 className="rail__title">{title}</h3>
        <ul className="rail__list">
          {Array.from({ length: view.slotCount }, (_, i) => (
            <li key={i} className="slot slot--sealed">
              <span className="slot__seal" aria-hidden="true">
                ●
              </span>
              <span className="slot__name">Sealed</span>
            </li>
          ))}
        </ul>
        {view.hasCommitted ? <p className="rail__note">{SEALED_NOTE}</p> : null}
      </section>
    )
  }

  return (
    <section className="rail" aria-label={title}>
      <h3 className="rail__title">{title}</h3>
      <ul className="rail__list">
        {view.slots.map((slot) => {
          const character = byId.get(slot.characterId)
          const bannedNow = slot.bannedInRound !== null && slot.bannedInRound === currentRound
          const choosable = selectable.includes(slot.index)
          const classes = [
            'slot',
            slot.consumed ? 'slot--spent' : '',
            bannedNow ? 'slot--banned' : '',
            choosable ? 'slot--choosable' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const status = slot.consumed ? 'played' : bannedNow ? 'banned this round' : 'available'

          return (
            <li key={slot.index}>
              <button
                type="button"
                className={classes}
                disabled={!choosable}
                aria-label={`${character?.name ?? slot.characterId} — ${status}`}
                onClick={() => onSelect?.(slot.index)}
              >
                <span className="slot__name">{character?.name ?? slot.characterId}</span>
                <span className="slot__status">
                  {slot.consumed ? 'Played' : bannedNow ? 'Banned' : choosable ? 'Choose' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
