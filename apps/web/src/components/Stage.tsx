import { useEffect, useRef, useState } from 'react'
import type { Character, CharId, PlayerView, Seat, Slot, SlotIdx } from '@banpick/types'

import { Portrait } from './Portrait.js'
import { play } from '../sound.js'

/**
 * The board, always in the same place.
 *
 * A fighting game's select screen holds one arrangement for the whole draft — your side, their
 * side, the roster underneath — and swaps what is *live* rather than what is *there*. That
 * stability is the point: the rails used to be a vertical list that appeared and disappeared as
 * panels opened, so nothing stayed put long enough to be read at a glance.
 *
 * So this renders a fixed row of slots per seat and changes only their state. Five states, and
 * the split between the middle two is the one piece of honesty the component owes:
 *
 *   - **empty** — nothing here yet
 *   - **choosing** — filled according to the *other browser*, which the server cannot verify
 *   - **sealed** — committed to the server, contents hidden (§7)
 *   - **revealed** — face up
 *   - **spent / banned** — played (D6) or denied this round (D3)
 *
 * A pending count comes from the opponent's own client; a draft is one `COMMIT`, so until it
 * lands there is nothing authoritative to report. Drawing that identically to a sealed slot
 * would present a guess as a fact.
 */

export interface Pending {
  filled: number
  /** Real ids, for your own side only — yours are not secret from you. */
  picks?: CharId[]
  ban?: boolean
}

export interface StageProps {
  view: PlayerView
  /** `draftCount`, so the row is the right width before anyone commits. */
  expected: number
  mine: Pending
  theirs: Pending
  /** Slot indices the server says are choosable, per side. */
  selectableOwn?: SlotIdx[]
  selectableOpponent?: SlotIdx[]
  onSelectOwn?: (index: SlotIdx) => void
  onSelectOpponent?: (index: SlotIdx) => void
  /**
   * Undo one of your own not-yet-committed picks, by clicking it on the board.
   *
   * This is where taking a pick back lives now. It used to be a separate "slot 1 / slot 2 / …"
   * strip under the picker, which restated the same four boxes the board was already drawing —
   * two places showing one thing, and the removal affordance stranded in the wrong one.
   */
  onRemoveOwn?: (id: CharId) => void
  /** Plays the staggered flip once, when a side opens. */
  revealing?: boolean
}

/**
 * Layout, in numbers rather than in CSS.
 *
 * Cells are absolutely positioned and moved with `transform`, because that is the only way the
 * *reordering* animates — a card sliding from the middle of the row to the centre, or out to the
 * edge when it is spent. Flex `order` would reposition instantly and lose the whole effect, so
 * the pitch has to be arithmetic the component can do.
 *
 * `CELL_PX` must match `--stage-cell`; `sizing.test.tsx` asserts they agree.
 */
const CELL_PX = 132
const GAP_PX = 6
const PITCH = CELL_PX + GAP_PX
/** Fixed so the lock-in ring can be sized without measuring the DOM. */
const VS_WIDTH_PX = 44
/** `.stage__sides` gap — the space either side of the "vs", not the space between cells. */
const SIDES_GAP_PX = 8
/**
 * Everything on a card that is not the portrait: 6px padding top and bottom, the 4px gap under
 * the art, and the name's line box. Measured rather than guessed — the first value was 26, four
 * short, so every card overflowed its own row by four pixels and rode up over the text above it.
 * `.cell` is given this height explicitly in CSS so the arithmetic and the rendering cannot
 * disagree again.
 */
const CARD_CHROME_PX = 30
/** Card height at rest. The portrait keeps the source art's 199×300, plus the chrome above. */
const CARD_HEIGHT_PX = CELL_PX * (300 / 199) + CARD_CHROME_PX
/** Breathing room, so the ring encloses the pair rather than tracing them. */
const RING_PAD_PX = 12

/**
 * The board's natural width, at the largest draft the modes allow.
 *
 * Four cells a side on a fixed pitch, twice, plus the gaps and the "vs" column. Everything on the
 * board is positioned from this arithmetic, which is what makes the movement animate — and also
 * what makes the board a fixed object rather than a reflowing one.
 */
function naturalWidth(slots: number): number {
  const side = slots * CELL_PX + Math.max(0, slots - 1) * GAP_PX
  return side * 2 + SIDES_GAP_PX * 2 + VS_WIDTH_PX
}

/** Below this the board is unreadable however you scale it; let the page scroll instead. */
const MIN_SCALE = 0.6

/**
 * Scales the whole board to fit its container.
 *
 * A transform rather than a reflow, deliberately. Every position on this board is arithmetic —
 * the pitch, the ring, the reveal offsets — and a second, narrower layout would mean maintaining
 * that arithmetic twice and animating between two of them. Scaling keeps one board and one set of
 * numbers; it just makes them smaller.
 *
 * The app is desktop-first as of 2026-07-31 (see the struck exit criterion in the delivery plan),
 * so this is about a small laptop or a half-width window, not a phone.
 */
function useBoardScale(natural: number): {
  ref: (node: HTMLDivElement | null) => void
  scale: number
} {
  const [scale, setScale] = useState(1)
  const [node, setNode] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? natural
      setScale(Math.max(MIN_SCALE, Math.min(1, width / natural)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, natural])

  return { ref: setNode, scale }
}

/**
 * Stacking on the board, in one place.
 *
 * The ring is deliberately the top layer. It is wider than the pair it encloses — that is the
 * point — so its edges pass over the cards on either side, and underneath them it was simply
 * invisible. Nothing is hidden by putting it on top: the ring is a border and a glow with a
 * transparent middle, and it takes no pointer events.
 */
const Z_CELL = 1
const Z_CELL_CHOSEN = 2
const Z_LOCK_IN = 3
/** The character being played this round, blown up next to the "vs". */
const CHOSEN_SCALE = 1.5

const FLIP_STAGGER_MS = 150

/** How long the two cards pulse separately before the joined border takes over. */
const LOCK_IN_DELAY_MS = 900

/**
 * Where a slot sits, measured out from the centre line.
 *
 * Rank 0 is nearest the "vs" and 3 is furthest, so the row tells the round's story by position
 * alone: what you are playing sits in the middle, what is still available flanks it, and what is
 * out of play this round drifts to the edge.
 */
type Rank = 0 | 1 | 2 | 3

function rankOf(slot: Slot | undefined, chosen: boolean, bannedNow: boolean): Rank {
  if (slot === undefined) return 1
  if (chosen) return 0 // the character being played, centre stage
  if (slot.consumed) return 3 // spent, and furthest out — but see `spent` above: a slot is
  //                             consumed the moment it is selected, so this only reaches the
  //                             card once it is no longer the current selection.
  if (bannedNow) return 2 // denied for this round only (D3), so not as far as spent
  return 1
}

/** Display order, nearest the centre first. Ties keep slot order, so nothing jitters. */
function orderFor(entries: { index: number; rank: Rank }[]): number[] {
  const sorted = [...entries].sort((a, b) => a.rank - b.rank || a.index - b.index)
  const position = new Map(sorted.map((e, i) => [e.index, i]))
  return entries.map((e) => position.get(e.index)!)
}

/**
 * The reveal: outside-in, one card at a time, alternating sides.
 *
 * Starting at the outermost pair and walking inward puts the last flip next to the "vs", which is
 * where the eye already is. Alternating means neither player is simply told first.
 */
function revealDelay(position: number, count: number, own: boolean): number {
  return ((count - 1 - position) * 2 + (own ? 0 : 1)) * FLIP_STAGGER_MS
}

/** One card's flip. Must match the `slot-flip` animation in the stylesheet. */
const FLIP_DURATION_MS = 420

/**
 * How long the whole reveal takes, last card included.
 *
 * Exported because `Match` has to hold the dice back until it finishes, and a number guessed
 * separately over there is a number that drifts — the first version cut the last two cards off
 * because it had been estimated rather than derived.
 */
export function revealDurationMs(count: number): number {
  return revealDelay(0, count, false) + FLIP_DURATION_MS
}

export function Stage({
  view,
  expected,
  mine,
  theirs,
  selectableOwn = [],
  selectableOpponent = [],
  onSelectOwn,
  onSelectOpponent,
  onRemoveOwn,
  revealing = false,
}: StageProps) {
  const byId = new Map(view.roster.map((c) => [c.id, c]))
  const round = view.phase?.roundIndex ?? null

  /**
   * Who each seat is playing this round, when that is known.
   *
   * Absent while a selection is sealed (round 2 picks simultaneously and hidden), which is
   * exactly right: an unrevealed choice must not pull a card to centre stage and announce itself.
   */
  const selection = round !== null ? view.rounds[round]?.selection : undefined
  const chosenOwn = selection?.[view.seat] ?? null
  const chosenOpponent = selection?.[view.opponent.seat] ?? null

  /**
   * How each played character finished, by slot.
   *
   * A slot is spent because it was selected in some round, and that round has a result — so the
   * card can carry its own outcome for the rest of the match rather than becoming an anonymous
   * grey square. Built per seat because the same round is a win for one and a loss for the other.
   */
  const outcomes = (seat: Seat): Map<number, 'win' | 'loss' | 'tie'> => {
    const out = new Map<number, 'win' | 'loss' | 'tie'>()
    for (const r of view.rounds) {
      const slotIndex = r.selection[seat]
      if (slotIndex === undefined || slotIndex === null || r.result === null) continue
      out.set(slotIndex, r.result === 'TIE' ? 'tie' : r.result === seat ? 'win' : 'loss')
    }
    return out
  }

  /** Set once the match is over: the winning side keeps its colour, the other steps back. */
  const finished = view.status === 'COMPLETE' ? (view.outcome ?? null) : null

  /**
   * One floor for both sides.
   *
   * The rows used to size themselves, which meant the side with a card at centre stage grew
   * taller than the side without one — and since the two are grid items aligned to the top, the
   * shorter row hung from the ceiling while its opposite stood on the ground. They are one board
   * and the cards stand on one line, so the extra room a blown-up card needs is reserved for
   * both the moment *either* seat has one.
   */
  const anyChosen = chosenOwn !== null || chosenOpponent !== null
  // Scaling the *card* scales its chrome too, so the row has to grow by the same factor —
  // measuring only the portrait left the blown-up card overflowing its own row by ~13px.
  const rowHeight = Math.round(CARD_HEIGHT_PX * (anyChosen ? CHOSEN_SCALE : 1))

  /**
   * Both cards are at centre stage — so after a beat, one border replaces two.
   *
   * The individual rings say "I have chosen"; a single ring around the pair says "we are locked
   * in", which is a different statement and wants a different shape. The delay is what makes it
   * read as a *transition* rather than as a third state that was always there: the second player
   * commits, their card arrives and pulses on its own, and only then do the two become one.
   */
  const bothChosen = chosenOwn !== null && chosenOpponent !== null
  const [lockedIn, setLockedIn] = useState(false)

  useEffect(() => {
    if (!bothChosen) {
      setLockedIn(false)
      return
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLockedIn(true)
      return
    }
    const t = setTimeout(() => {
      setLockedIn(true)
      play('lockIn')
    }, LOCK_IN_DELAY_MS)
    return () => clearTimeout(t)
  }, [bothChosen])

  const natural = naturalWidth(Math.max(expected, view.you.slotCount, view.opponent.slotCount))
  const { ref: fitRef, scale } = useBoardScale(natural)

  return (
    <section className="stage" aria-label="Draft board" ref={fitRef}>
      <BanBar view={view} byId={byId} mine={mine} theirs={theirs} />

      {/* The board keeps its natural size and is scaled to fit, so nothing inside has to know
          how wide the window is. The wrapper reserves the scaled height so the page below it
          does not sit under a shrunken board. */}
      <div
        className="stage__fit"
        style={{ height: scale < 1 ? `${Math.round(rowHeight * scale) + 40}px` : undefined }}
      >
        <div
          className="stage__board"
          style={{ width: `${natural}px`, transform: `scale(${scale})` }}
        >
          <div className={`stage__sides ${lockedIn ? 'stage__sides--locked' : ''}`}>
            {/*
          One ring around the pair, sized from the same arithmetic that places the cards: two
          blown-up cells, the gaps either side of the "vs", and the "vs" column itself.
        */}
            {lockedIn ? (
              <span
                className="lockin"
                aria-hidden="true"
                style={{
                  zIndex: Z_LOCK_IN,
                  width: `${Math.round(CELL_PX * CHOSEN_SCALE) * 2 + SIDES_GAP_PX * 2 + VS_WIDTH_PX + RING_PAD_PX * 2}px`,
                  height: `${Math.round(CARD_HEIGHT_PX * CHOSEN_SCALE) + RING_PAD_PX * 2}px`,
                  bottom: `${-RING_PAD_PX}px`,
                }}
              />
            ) : null}
            <Side
              title="You"
              seat={view.seat}
              seatView={view.you}
              byId={byId}
              expected={expected}
              pending={mine}
              currentRound={round}
              selectable={selectableOwn}
              chosenSlot={chosenOwn}
              outcomes={outcomes(view.seat)}
              rowHeight={rowHeight}
              finish={
                finished === null
                  ? null
                  : finished === 'DRAW'
                    ? 'draw'
                    : finished === view.seat
                      ? 'won'
                      : 'lost'
              }
              onSelect={onSelectOwn}
              onRemove={onRemoveOwn}
              revealing={revealing}
              own
            />
            <span className="stage__vs" aria-hidden="true">
              vs
            </span>
            <Side
              title="Them"
              seat={view.opponent.seat}
              seatView={view.opponent}
              byId={byId}
              expected={expected}
              pending={theirs}
              currentRound={round}
              selectable={selectableOpponent}
              chosenSlot={chosenOpponent}
              outcomes={outcomes(view.opponent.seat)}
              rowHeight={rowHeight}
              finish={
                finished === null
                  ? null
                  : finished === 'DRAW'
                    ? 'draw'
                    : finished === view.opponent.seat
                      ? 'won'
                      : 'lost'
              }
              onSelect={onSelectOpponent}
              onRemove={undefined}
              revealing={revealing}
              own={false}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * The bans, above the teams.
 *
 * D4 scopes a meta ban to the *opponent*, so the character shown under "Them" is one of **yours**
 * that they closed off. Labelling it by who *placed* it rather than whose rail it sits on is the
 * only way that reads correctly — hence "They banned" rather than a bare "Ban".
 */
function BanBar({
  view,
  byId,
  mine,
  theirs,
}: {
  view: PlayerView
  byId: Map<CharId, Character>
  mine: Pending
  theirs: Pending
}) {
  /**
   * The bans matter only while they can still change what you do.
   *
   * They are worth showing through the ban phase and the draft — that is the whole reason the ban
   * moved in front of the draft, so you choose knowing what is gone. Once both rosters are locked
   * the information is spent: it cannot affect another decision, and the character it names is
   * visibly absent from the boards below it.
   */
  const rostersLocked = view.you.hasCommitted && view.opponent.hasCommitted
  if (rostersLocked) return null

  const yours = view.you.metaBanPlaced ?? null
  const opponent = view.opponent.metaBanPlaced ?? null
  const anything = yours || opponent || mine.ban || theirs.ban
  if (!anything) return null

  return (
    <div className="banbar" aria-label="Meta bans">
      <BanCell label="You banned" id={yours} pending={mine.ban === true} byId={byId} />
      <BanCell label="They banned" id={opponent} pending={theirs.ban === true} byId={byId} />
    </div>
  )
}

function BanCell({
  label,
  id,
  pending,
  byId,
}: {
  label: string
  id: CharId | null
  pending: boolean
  byId: Map<CharId, Character>
}) {
  if (!id && !pending) return null
  const character = id ? byId.get(id) : undefined

  return (
    <p className={`bancell ${id ? 'bancell--placed' : 'bancell--pending'}`}>
      <span className="bancell__label">{label}</span>
      {character ? (
        <>
          {/* Greyed, because it is out of play — the same treatment the roster tile gets. */}
          <Portrait character={character} size="chip" dimmed />
          <span className="bancell__name">{character.name}</span>
        </>
      ) : (
        <span className="bancell__name bancell__name--pending">chosen</span>
      )}
    </p>
  )
}

/**
 * A score that moves when it changes.
 *
 * Half points are real here — D21 scores a tied round 0.5 each — so this formats in halves rather
 * than assuming integers, and it flashes on change so a point landing is visible even if you were
 * reading the other side of the board when it happened.
 */
function Score({ value }: { value: number }) {
  const previous = useRef(value)
  const [bumped, setBumped] = useState(false)

  useEffect(() => {
    if (value === previous.current) return
    previous.current = value
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    setBumped(true)
    const t = setTimeout(() => setBumped(false), 600)
    return () => clearTimeout(t)
  }, [value])

  return (
    <span className={`side__score ${bumped ? 'side__score--bumped' : ''}`}>
      {Number.isInteger(value) ? value : value.toFixed(1)}
    </span>
  )
}

function Side({
  title,
  seat,
  seatView,
  byId,
  expected,
  pending,
  currentRound,
  selectable,
  chosenSlot,
  outcomes,
  finish,
  rowHeight,
  onSelect,
  onRemove,
  revealing,
  own,
}: {
  title: string
  seat: string
  seatView: PlayerView['you']
  byId: Map<CharId, Character>
  expected: number
  pending: Pending
  currentRound: number | null
  selectable: SlotIdx[]
  /** The slot this seat is playing this round, or null while unchosen or still sealed. */
  chosenSlot: SlotIdx | null
  /** How each already-played slot finished, so a spent card still says what it did. */
  outcomes: Map<number, 'win' | 'loss' | 'tie'>
  /** How the match ended for this seat, once it has. */
  finish: 'won' | 'lost' | 'draw' | null
  /** Decided by the stage, so both sides stand on the same line. */
  rowHeight: number
  onSelect: ((index: SlotIdx) => void) | undefined
  onRemove: ((id: CharId) => void) | undefined
  revealing: boolean
  own: boolean
}) {
  // Slots start as a **public empty slice** and only go absent once a commit seals them, so
  // presence alone does not mean "revealed". Emptiness means "not yet"; absence means "sealed".
  const slots = seatView.slots ?? []
  const revealed = slots.length > 0

  const boxes = revealed ? slots.length : Math.max(expected, seatView.slotCount)
  const filled = revealed ? boxes : seatView.hasCommitted ? boxes : Math.min(pending.filled, boxes)

  const cells = Array.from({ length: boxes }, (_, i) => {
    const slot = revealed ? slots[i] : undefined
    // Your locally-held picks stop being *yours to edit* the moment the commit lands, so a
    // sealed side falls back to sealed cells. Without the `hasCommitted` term a committed draft
    // kept drawing the local copy and kept offering to remove it — which §12 forbids.
    const localPick = !revealed && own && !seatView.hasCommitted ? pending.picks?.[i] : undefined
    const character = slot
      ? byId.get(slot.characterId)
      : localPick
        ? byId.get(localPick)
        : undefined

    /**
     * Banned *this* round — and `null === null` is not that.
     *
     * `bannedInRound` is null on a slot nobody has banned, and `currentRound` is null whenever
     * there is no round: through the ban and draft phases, and again once the match ends and
     * there is no phase at all. Comparing them directly made every **un**banned slot report
     * itself banned in exactly those two moments — the whole roster stamped the instant it was
     * revealed, and again on the final screen.
     *
     * The explicit null check is what `SlotRail` had and this lost in the rewrite.
     */
    const bannedNow =
      slot !== undefined && slot.bannedInRound !== null && slot.bannedInRound === currentRound
    const chosen = slot !== undefined && slot.index === chosenSlot
    /**
     * Spent, for display purposes — which is **not** the same as `slot.consumed`.
     *
     * Selecting a character consumes its slot immediately (D6 consumes it even on a tie), so the
     * character you are about to play is already `consumed` while you are playing it. Drawing
     * that state means the card you just chose greys out, strikes through its own name and fades
     * — at the exact moment it is the most alive thing on the board. It reads as spent once the
     * round moves on and it stops being the selection.
     */
    const spent = slot?.consumed === true && !chosen
    const choosable = slot ? selectable.includes(slot.index) : false
    // Only your own, only before it is committed — §12 forbids withdrawing a sealed one.
    const removable = !revealed && own && localPick !== undefined && onRemove !== undefined
    const state = revealed
      ? 'revealed'
      : i >= filled
        ? 'empty'
        : character
          ? 'mine'
          : seatView.hasCommitted
            ? 'sealed'
            : 'choosing'

    const outcome = slot ? (outcomes.get(slot.index) ?? null) : null
    return { i, slot, character, bannedNow, chosen, spent, outcome, choosable, removable, state }
  })

  const positions = orderFor(
    cells.map((c) => ({ index: c.i, rank: rankOf(c.slot, c.chosen, c.bannedNow) })),
  )

  return (
    <div
      className={`side ${own ? 'side--own' : 'side--opponent'} ${finish ? `side--${finish}` : ''}`}
    >
      <div className="side__head">
        <h3 className="side__title">{title}</h3>
        <span className="side__seat">{seat}</span>
        <Score value={seatView.score} />
      </div>

      {/*
        Absolutely positioned, and moved with `transform`, so a card changing rank *slides*.
        Reordering the DOM (or flex `order`) would snap it there instead, and the movement is the
        whole point — a character walking out to the edge when it is spent says "gone" more
        plainly than greying it in place.
      */}
      <ul
        className={`side__row ${cells.some((c) => c.chosen) ? 'side__row--focused' : ''}`}
        style={{ height: `${rowHeight}px` }}
      >
        {cells.map(
          ({
            i,
            slot,
            character,
            bannedNow,
            chosen,
            spent,
            outcome,
            choosable,
            removable,
            state,
          }) => {
            const position = positions[i]!
            // The row grows away from the centre line, so every cell is offset outward from it.
            const offset = position * PITCH * (own ? -1 : 1)
            const scale = chosen ? CHOSEN_SCALE : 1

            const classes = [
              'cell',
              `cell--${state}`,
              removable ? 'cell--removable' : '',
              spent ? 'cell--spent' : '',
              bannedNow ? 'cell--banned' : '',
              chosen ? 'cell--chosen' : '',
              outcome ? `cell--${outcome}` : '',
              choosable ? 'cell--choosable' : '',
              revealing && revealed ? 'cell--flip' : '',
            ]
              .filter(Boolean)
              .join(' ')

            const label = character
              ? `${character.name}${
                  spent
                    ? ' — played'
                    : bannedNow
                      ? ' — banned this round'
                      : chosen
                        ? ' — playing this round'
                        : ''
                }`
              : state === 'empty'
                ? 'Empty slot'
                : state === 'sealed'
                  ? 'Sealed'
                  : 'Chosen'

            const body = (
              <>
                {character ? (
                  <Portrait character={character} size="card" dimmed={spent || bannedNow} />
                ) : (
                  <span className="cell__frame" aria-hidden="true">
                    {state === 'empty' ? '' : '●'}
                  </span>
                )}
                {/* Said outright rather than implied by a colour: a ban lasts one round (D3), and
                  "greyed" alone reads the same as "already played", which is permanent. */}
                {bannedNow ? <span className="cell__stamp">Round banned</span> : null}
                <span className="cell__name">{character ? character.name : label}</span>
                {removable ? (
                  <span className="cell__remove" aria-hidden="true">
                    Remove
                  </span>
                ) : null}
              </>
            )

            return (
              <li
                key={slot ? slot.index : i}
                className={`cell-slot ${chosen ? 'cell-slot--chosen' : ''}`}
                style={{
                  width: `${CELL_PX}px`,
                  transform: `translateX(${offset}px) scale(${scale})`,
                  // Grows toward the centre line, into the gap beside the "vs".
                  transformOrigin: own ? 'right bottom' : 'left bottom',
                  zIndex: chosen ? Z_CELL_CHOSEN : Z_CELL,
                  ...(revealing && revealed
                    ? ({
                        '--flip-delay': `${revealDelay(position, boxes, own)}ms`,
                      } as React.CSSProperties)
                    : {}),
                }}
              >
                {choosable && slot ? (
                  <button
                    type="button"
                    className={classes}
                    aria-label={label}
                    onClick={() => onSelect?.(slot.index)}
                  >
                    {body}
                  </button>
                ) : removable ? (
                  <button
                    type="button"
                    className={classes}
                    aria-label={`Remove ${character?.name ?? ''}`.trim()}
                    onClick={() => onRemove?.(cells[i]!.character?.id ?? '')}
                  >
                    {body}
                  </button>
                ) : (
                  /*
                   * The label goes on the wrapper when there is no button to carry it. A played
                   * or banned card is not pressable, but it still has something to say — without
                   * this a screen reader hears the character's name and none of its state.
                   */
                  <div className={classes} aria-label={label} role="img">
                    {body}
                  </div>
                )}
              </li>
            )
          },
        )}
      </ul>
    </div>
  )
}
