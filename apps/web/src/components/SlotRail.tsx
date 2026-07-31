import { useEffect, useRef, useState } from 'react'
import type { Character, CharId, RoundIdx, SeatView, SlotIdx } from '@banpick/types'

import { SEALED_NOTE } from '../copy.js'
import { Portrait } from './Portrait.js'

/**
 * A seat's slots.
 *
 * Slots are an **ordered array, not a set** (§5) — they are the addressable ban target, and
 * with cross-seat mirrors allowed (D1) a character ID would not identify a unique one. So the
 * rail is positional, and position is the thing a player has to be able to point at.
 *
 * The rail is on screen for the whole match, including *during* the draft, which is the point:
 * both players watch the same boxes fill. Five states, each of which has to read differently at
 * a glance:
 *
 *   - **empty** — nobody has put anything here yet
 *   - **choosing** — filled, but only according to the other browser (see `pending` below)
 *   - **sealed** — committed to the server, and you may not see it (§7)
 *   - **revealed** — face up, with art
 *   - **consumed / banned this round** — played (D6) or denied for now (D3)
 *
 * The choosing/sealed split is deliberate and is the one piece of honesty this component owes.
 * A pending count comes from the opponent's own client and the server cannot check it — a draft
 * is one `COMMIT`, so until it lands there is nothing authoritative to report. Drawing that the
 * same as a sealed slot would present a guess as a fact.
 */

export interface SlotRailProps {
  view: SeatView
  roster: Character[]
  currentRound: RoundIdx | null
  /** Slots the server says are choosable right now. Empty when it is not this seat's move. */
  selectable?: SlotIdx[]
  onSelect?: (index: SlotIdx) => void
  title: string
  /**
   * How many boxes to draw before anything is committed.
   *
   * `view.slotCount` is zero until the commit lands, so on its own it gives an empty rail through
   * the entire draft and then four boxes at once. This is `draftCount` from the ruleset — public,
   * authoritative, and known from the moment the match is created.
   */
  expected?: number
  /**
   * Slots filled but not yet committed. **Not authoritative.**
   *
   * For your own rail these are your real picks, shown face up because they are yours. For the
   * opponent's they are a count only, drawn face down.
   */
  pending?: { filled: number; picks?: CharId[]; ban?: boolean }
  /**
   * How to describe this seat's meta ban.
   *
   * It needs saying explicitly because the ban targets the *opponent* (D4): the character under
   * "Theirs" is one of **yours** that they removed. Labelling it "Meta ban" on their rail reads
   * as though one of their own is gone, which is the opposite of what happened.
   */
  banLabel?: string
}

const FLIP_STAGGER_MS = 150

export function SlotRail({
  view,
  roster,
  currentRound,
  selectable = [],
  onSelect,
  title,
  expected = 0,
  pending,
  banLabel = 'Meta ban',
}: SlotRailProps) {
  const byId = new Map(roster.map((c) => [c.id, c]))

  /**
   * Whether there is anything real to draw.
   *
   * **Not** `view.slots !== undefined`. Slots begin life as a *public empty slice* and only
   * become owned — and therefore absent — when the commit lands. So before anyone drafts, a
   * seat's `slots` is `[]` and perfectly visible, which is not the same as "revealed, holding
   * nothing". Keying on presence alone put the rail on the revealed path with an empty array and
   * drew no boxes at all, which is the blank draft this whole component exists to fix.
   */
  const shown = view.slots ?? []
  const hasContent = shown.length > 0
  const flipping = useReveal(hasContent, shown.length)

  // §7: a hidden slice is *absent*, not null and not flagged — so once a commit lands, the check
  // is existence. Before it lands, an empty array means the same thing to a player: nothing here
  // yet. Both land on the placeholder rail.
  if (!hasContent) {
    const boxes = Math.max(expected, view.slotCount)
    const filled = view.hasCommitted ? boxes : Math.min(pending?.filled ?? 0, boxes)

    return (
      <section className="rail" aria-label={title}>
        <RailHead title={title} filled={filled} of={boxes} sealed={view.hasCommitted} />
        <ul className="rail__list">
          {Array.from({ length: boxes }, (_, i) => {
            const own = pending?.picks?.[i]
            const character = own ? byId.get(own) : undefined
            const state = i >= filled ? 'empty' : view.hasCommitted ? 'sealed' : 'choosing'

            return (
              <li key={i} className={`slot slot--${state}`}>
                {character ? (
                  // Your own pick, before you commit. Face up because it is yours — the seal is
                  // against your opponent, not against you.
                  <>
                    <Portrait character={character} size="slot" />
                    <span className="slot__name">{character.name}</span>
                  </>
                ) : (
                  <>
                    <span className="slot__face" aria-hidden="true">
                      {state === 'empty' ? '' : '●'}
                    </span>
                    <span className="slot__name">
                      {state === 'empty' ? 'Empty' : state === 'sealed' ? 'Sealed' : 'Chosen'}
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        <BanChip
          label={banLabel}
          placed={view.hasCommitted ? (view.metaBanPlaced ?? undefined) : undefined}
          pending={!view.hasCommitted && pending?.ban === true}
          roster={byId}
        />
        {view.hasCommitted ? <p className="rail__note">{SEALED_NOTE}</p> : null}
      </section>
    )
  }

  return (
    <section className="rail" aria-label={title}>
      <RailHead title={title} filled={shown.length} of={shown.length} sealed={false} />
      <ul className="rail__list">
        {shown.map((slot) => {
          const character = byId.get(slot.characterId)
          const bannedNow = slot.bannedInRound !== null && slot.bannedInRound === currentRound
          const choosable = selectable.includes(slot.index)
          const classes = [
            'slot',
            'slot--revealed',
            slot.consumed ? 'slot--spent' : '',
            bannedNow ? 'slot--banned' : '',
            choosable ? 'slot--choosable' : '',
            flipping ? 'slot--flip' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const status = slot.consumed ? 'played' : bannedNow ? 'banned this round' : 'available'

          return (
            <li key={slot.index}>
              <button
                type="button"
                className={classes}
                // Per-slot delay is what makes the reveal staggered rather than simultaneous.
                style={
                  flipping
                    ? ({
                        '--flip-delay': `${slot.index * FLIP_STAGGER_MS}ms`,
                      } as React.CSSProperties)
                    : undefined
                }
                disabled={!choosable}
                aria-label={`${character?.name ?? slot.characterId} — ${status}`}
                onClick={() => onSelect?.(slot.index)}
              >
                {character ? (
                  <Portrait character={character} size="slot" dimmed={slot.consumed || bannedNow} />
                ) : null}
                <span className="slot__name">{character?.name ?? slot.characterId}</span>
                <span className="slot__status">
                  {slot.consumed ? 'Played' : bannedNow ? 'Banned' : choosable ? 'Choose' : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {view.metaBanPlaced ? (
        <BanChip label={banLabel} placed={view.metaBanPlaced} pending={false} roster={byId} />
      ) : null}
    </section>
  )
}

function RailHead({
  title,
  filled,
  of,
  sealed,
}: {
  title: string
  filled: number
  of: number
  sealed: boolean
}) {
  return (
    <div className="rail__head">
      <h3 className="rail__title">{title}</h3>
      {of > 0 && filled < of && !sealed ? (
        <span className="rail__count" aria-live="polite">
          {filled} of {of}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The meta ban.
 *
 * Not a slot: slots are the positional ban *target* (§5), and adding a fifth box would make the
 * rail lie about how many characters a seat holds. It gets its own chip beside them.
 */
function BanChip({
  label,
  placed,
  pending,
  roster,
}: {
  label: string
  placed?: CharId | undefined
  pending: boolean
  roster: Map<CharId, Character>
}) {
  if (!placed && !pending) return null
  const character = placed ? roster.get(placed) : undefined

  return (
    <p className={`banchip ${placed ? 'banchip--placed' : 'banchip--pending'}`}>
      <span className="banchip__label">{label}</span>
      <span className="banchip__value">{character ? character.name : 'chosen'}</span>
    </p>
  )
}

/**
 * True for one beat after slots first become visible, so the flip plays once.
 *
 * Keyed on the transition from hidden to visible rather than on a timer or a mount: the rail
 * re-renders constantly, and a flip that replayed on every frame would be unwatchable.
 */
function useReveal(revealed: boolean, count: number): boolean {
  const wasRevealed = useRef(revealed)
  const [flipping, setFlipping] = useState(false)

  useEffect(() => {
    if (revealed === wasRevealed.current) return
    wasRevealed.current = revealed
    if (!revealed) return

    // Someone who asked their system not to animate gets the cards face up immediately.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return

    setFlipping(true)
    const done = setTimeout(() => setFlipping(false), count * FLIP_STAGGER_MS + 600)
    return () => clearTimeout(done)
  }, [revealed, count])

  return flipping
}
