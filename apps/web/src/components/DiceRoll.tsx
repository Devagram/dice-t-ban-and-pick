import { useEffect, useState } from 'react'
import type { PlayerView, Seat } from '@banpick/types'

import { play } from '../sound.js'

/**
 * The priority roll, played out rather than reported.
 *
 * **This is a reveal, not a roll.** The dice were thrown on the server the moment the round
 * opened — seeded, recorded, and already in the event log before any browser heard about it
 * (§11: the DO is the authority for all dice). Nothing here can change the outcome, and the
 * animation is careful never to imply otherwise: the tumbling faces are decorative, and the
 * numbers that land are the ones the server sent.
 *
 * What makes it worth watching is `throws`. A tie forces a reroll (`onTie: REROLL`) and at 1d6
 * that happens about one round in six. Without the per-attempt record this could only say
 * "after 2 attempts"; with it, both players watch the tie land, hold, and roll again — which is
 * the most dramatic thing that happens in the whole match and used to be invisible.
 */

const TUMBLE_MS = 900
const HOLD_MS = 850
const TIE_BEAT_MS = 1100

type Stage = { index: number; phase: 'tumbling' | 'landed' }

export function DiceRoll({
  view,
  roll,
  onDone,
}: {
  view: PlayerView
  roll: NonNullable<PlayerView['rounds'][number]['roll']>
  onDone?: () => void
}) {
  const throws = roll.throws.length > 0 ? roll.throws : [roll.results]
  const [stage, setStage] = useState<Stage>({ index: 0, phase: 'tumbling' })

  useEffect(() => {
    // Honour a reduced-motion preference by skipping straight to the result. Someone who has
    // asked their system not to animate things should not be made to sit through a suspense
    // beat to find out who bans first.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setStage({ index: throws.length - 1, phase: 'landed' })
      onDone?.()
      return
    }

    const timers: ReturnType<typeof setTimeout>[] = []
    let elapsed = 0

    throws.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setStage({ index: i, phase: 'tumbling' })
          play('dice')
        }, elapsed),
      )
      elapsed += TUMBLE_MS
      timers.push(setTimeout(() => setStage({ index: i, phase: 'landed' }), elapsed))
      // A tie gets an extra beat to register before the next throw starts.
      elapsed += i < throws.length - 1 ? TIE_BEAT_MS : HOLD_MS
    })

    timers.push(setTimeout(() => onDone?.(), elapsed))

    return () => timers.forEach(clearTimeout)
    // Deliberately empty: the whole schedule is built once, on mount. `Match` keys this
    // component by round, so a new roll gets a new component rather than a re-run — which is
    // what stops the dice re-tumbling every time an unrelated frame arrives.
  }, [])

  const current = throws[Math.min(stage.index, throws.length - 1)]!
  const isTie = current.A === current.B
  const isLast = stage.index === throws.length - 1
  const landed = stage.phase === 'landed'
  const opponent: Seat = view.seat === 'A' ? 'B' : 'A'

  return (
    <section className="roll" aria-label="Priority roll">
      <p className="roll__caption" aria-live="polite">
        {!landed
          ? 'Rolling…'
          : isTie && !isLast
            ? `Both rolled ${current.A} — roll again`
            : landed && isLast
              ? roll.winner === view.seat
                ? 'You win the roll'
                : 'They win the roll'
              : ''}
      </p>

      <div className="roll__dice">
        <Die
          label="You"
          value={current[view.seat]}
          tumbling={!landed}
          won={landed && isLast && roll.winner === view.seat}
          lost={landed && isLast && roll.winner !== view.seat}
        />
        <span className="roll__vs" aria-hidden="true">
          vs
        </span>
        <Die
          label="Them"
          value={current[opponent]}
          tumbling={!landed}
          won={landed && isLast && roll.winner === opponent}
          lost={landed && isLast && roll.winner !== opponent}
        />
      </div>

      {throws.length > 1 ? (
        <p className="roll__history">
          {throws.length} throws — {throws.length - 1} tied
        </p>
      ) : null}
    </section>
  )
}

/**
 * `value` is only shown once the die has landed. While tumbling it cycles faces, which are
 * decorative and deliberately not the real result — showing the true number early would give
 * away the outcome the animation exists to withhold for a moment.
 */
function Die({
  label,
  value,
  tumbling,
  won,
  lost,
}: {
  label: string
  value: number | undefined
  tumbling: boolean
  won: boolean
  lost: boolean
}) {
  const [face, setFace] = useState(1)

  useEffect(() => {
    if (!tumbling) return
    const id = setInterval(() => setFace(1 + Math.floor(Math.random() * 6)), 70)
    return () => clearInterval(id)
  }, [tumbling])

  const classes = [
    'die',
    tumbling ? 'die--tumbling' : 'die--landed',
    won ? 'die--won' : '',
    lost ? 'die--lost' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="die-slot">
      <span className="die-slot__label">{label}</span>
      <span className={classes} aria-label={tumbling ? `${label}: rolling` : `${label}: ${value}`}>
        <span className="die__face">{tumbling ? face : (value ?? '?')}</span>
      </span>
    </div>
  )
}
