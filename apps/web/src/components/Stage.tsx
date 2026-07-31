import type { Character, CharId, PlayerView, Slot, SlotIdx } from '@banpick/types'

import { Portrait } from './Portrait.js'

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
/** The character being played this round, blown up next to the "vs". */
const CHOSEN_SCALE = 1.5

const FLIP_STAGGER_MS = 150

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

  return (
    <section className="stage" aria-label="Draft board">
      <BanBar view={view} byId={byId} mine={mine} theirs={theirs} />

      <div className="stage__sides">
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
          onSelect={onSelectOpponent}
          onRemove={undefined}
          revealing={revealing}
          own={false}
        />
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

    return { i, slot, character, bannedNow, chosen, spent, choosable, removable, state }
  })

  const positions = orderFor(
    cells.map((c) => ({ index: c.i, rank: rankOf(c.slot, c.chosen, c.bannedNow) })),
  )

  // Only reserve room for a blown-up card when there is one. Reserving it always left a band of
  // dead space under every row for the whole draft.
  const anyChosen = cells.some((c) => c.chosen)
  const rowHeight = Math.round(CELL_PX * (300 / 199) * (anyChosen ? CHOSEN_SCALE : 1)) + 26

  return (
    <div className={`side ${own ? 'side--own' : 'side--opponent'}`}>
      <div className="side__head">
        <h3 className="side__title">{title}</h3>
        <span className="side__seat">{seat}</span>
        <span className="side__score">{seatView.score}</span>
      </div>

      {/*
        Absolutely positioned, and moved with `transform`, so a card changing rank *slides*.
        Reordering the DOM (or flex `order`) would snap it there instead, and the movement is the
        whole point — a character walking out to the edge when it is spent says "gone" more
        plainly than greying it in place.
      */}
      <ul
        className={`side__row ${anyChosen ? 'side__row--focused' : ''}`}
        style={{ height: `${rowHeight}px` }}
      >
        {cells.map(
          ({ i, slot, character, bannedNow, chosen, spent, choosable, removable, state }) => {
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
                  zIndex: chosen ? 2 : 1,
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
                  <div className={classes}>{body}</div>
                )}
              </li>
            )
          },
        )}
      </ul>
    </div>
  )
}
