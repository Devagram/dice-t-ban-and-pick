import type { Character, CharId, PlayerView, SlotIdx } from '@banpick/types'

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
  /** Plays the staggered flip once, when a side opens. */
  revealing?: boolean
}

const FLIP_STAGGER_MS = 150

export function Stage({
  view,
  expected,
  mine,
  theirs,
  selectableOwn = [],
  selectableOpponent = [],
  onSelectOwn,
  onSelectOpponent,
  revealing = false,
}: StageProps) {
  const byId = new Map(view.roster.map((c) => [c.id, c]))
  const round = view.phase?.roundIndex ?? null

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
          onSelect={onSelectOwn}
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
          onSelect={onSelectOpponent}
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
  onSelect,
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
  onSelect: ((index: SlotIdx) => void) | undefined
  revealing: boolean
  own: boolean
}) {
  // Slots start as a **public empty slice** and only go absent once a commit seals them, so
  // presence alone does not mean "revealed". Emptiness means "not yet"; absence means "sealed".
  const slots = seatView.slots ?? []
  const revealed = slots.length > 0

  const boxes = revealed ? slots.length : Math.max(expected, seatView.slotCount)
  const filled = revealed ? boxes : seatView.hasCommitted ? boxes : Math.min(pending.filled, boxes)

  return (
    <div className={`side ${own ? 'side--own' : 'side--opponent'}`}>
      <div className="side__head">
        <h3 className="side__title">{title}</h3>
        <span className="side__seat">{seat}</span>
        <span className="side__score">{seatView.score}</span>
      </div>

      <ul className="side__row">
        {Array.from({ length: boxes }, (_, i) => {
          const slot = revealed ? slots[i] : undefined
          const localPick = !revealed && own ? pending.picks?.[i] : undefined
          const character = slot
            ? byId.get(slot.characterId)
            : localPick
              ? byId.get(localPick)
              : undefined

          const bannedNow = slot ? slot.bannedInRound === currentRound : false
          const choosable = slot ? selectable.includes(slot.index) : false
          const state = revealed
            ? 'revealed'
            : i >= filled
              ? 'empty'
              : character
                ? 'mine'
                : seatView.hasCommitted
                  ? 'sealed'
                  : 'choosing'

          const classes = [
            'cell',
            `cell--${state}`,
            slot?.consumed ? 'cell--spent' : '',
            bannedNow ? 'cell--banned' : '',
            choosable ? 'cell--choosable' : '',
            revealing && revealed ? 'cell--flip' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const label = character
            ? `${character.name}${slot?.consumed ? ' — played' : bannedNow ? ' — banned this round' : ''}`
            : state === 'empty'
              ? 'Empty slot'
              : state === 'sealed'
                ? 'Sealed'
                : 'Chosen'

          const body = (
            <>
              {character ? (
                <Portrait
                  character={character}
                  size="card"
                  dimmed={slot?.consumed === true || bannedNow}
                />
              ) : (
                <span className="cell__face" aria-hidden="true">
                  {state === 'empty' ? '' : '●'}
                </span>
              )}
              <span className="cell__name">{character ? character.name : label}</span>
            </>
          )

          return (
            <li
              key={slot ? slot.index : i}
              className={choosable ? undefined : classes}
              style={
                revealing && revealed
                  ? ({ '--flip-delay': `${i * FLIP_STAGGER_MS}ms` } as React.CSSProperties)
                  : undefined
              }
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
              ) : (
                body
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
