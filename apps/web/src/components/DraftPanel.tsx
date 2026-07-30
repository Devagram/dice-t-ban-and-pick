import { useEffect, useState } from 'react'
import type { Action, CharId, PlayerActionPayload, PlayerView } from '@banpick/types'

import { META_BAN_HELP, META_BAN_PROMPT, SEALED_NOTE } from '../copy.js'
import { noteDrafted } from '../favourites.js'
import { CharacterPicker } from './CharacterPicker.js'

/**
 * The hidden commit: the draft, the meta ban, and the repick.
 *
 * Two things this has to get right beyond looking like a form.
 *
 * **The pools are per slot.** D12 forbids a seat holding the same character twice, and §6
 * implements that as a slot-indexed set difference — so the legal pool genuinely narrows as you
 * pick. The server sends one pool per slot; this walks them in order rather than filtering a
 * single list, because filtering would be re-deriving a rule it was handed.
 *
 * **The seal is the point.** §12: *"Withdraw a committed-but-unrevealed action? No. Commitment
 * is what makes the seal mean anything."* So the commit button says so before it is pressed,
 * and afterwards there is no edit affordance to look for.
 */

export interface DraftPanelProps {
  view: PlayerView
  commit: Extract<Action, { type: 'COMMIT' }>
  onAct: (payload: PlayerActionPayload) => void
  /** Reports how many slots are filled, so the opponent sees movement rather than a blank wait. */
  onProgress?: (filled: number, of: number) => void
}

export function DraftPanel({ view, commit, onAct, onProgress }: DraftPanelProps) {
  const [picks, setPicks] = useState<CharId[]>([])
  const [metaBan, setMetaBan] = useState<CharId | null>(null)

  const wantsPicks = commit.picks !== null
  const wantsBan = commit.metaBan !== null
  const picksDone = !wantsPicks || picks.length === commit.picks!.count
  const banDone = !wantsBan || metaBan !== null
  const ready = picksDone && banDone

  // The pool for the slot being filled next. Not a filtered copy of one list — see above.
  const currentPool = wantsPicks
    ? (commit.picks!.poolBySlot[Math.min(picks.length, commit.picks!.poolBySlot.length - 1)] ?? [])
    : []

  /**
   * Total decisions in this commit, so the opponent's bar counts the same things you do — a
   * `bring-ban1` draft is four picks *and* a ban, and a bar that reached "4 of 4" while you were
   * still choosing a ban would read as stalled rather than in progress.
   */
  const totalSteps = (wantsPicks ? commit.picks!.count : 0) + (wantsBan ? 1 : 0)
  const doneSteps = picks.length + (metaBan ? 1 : 0)

  useEffect(() => {
    onProgress?.(doneSteps, totalSteps)
  }, [doneSteps, totalSteps, onProgress])

  const submit = (): void => {
    if (wantsPicks) noteDrafted(picks)
    onAct({
      type: 'COMMIT',
      moduleId: commit.moduleId,
      seat: view.seat,
      picks,
      metaBan,
    })
  }

  return (
    <div className="draft">
      {wantsPicks ? (
        <>
          <SelectedStrip
            picks={picks}
            count={commit.picks!.count}
            roster={view.roster}
            onRemove={(id) => setPicks((p) => p.filter((x) => x !== id))}
          />
          {!picksDone ? (
            <CharacterPicker
              label="Your draft"
              help="Nobody sees these until both of you have committed."
              pool={currentPool.filter((id) => !picks.includes(id))}
              roster={view.roster}
              selected={picks}
              remaining={commit.picks!.count - picks.length}
              onSelect={(id) => setPicks((p) => [...p, id])}
            />
          ) : null}
        </>
      ) : null}

      {wantsBan && picksDone ? (
        <CharacterPicker
          label={META_BAN_PROMPT}
          help={META_BAN_HELP}
          pool={commit.metaBan!.pool}
          roster={view.roster}
          selected={metaBan ? [metaBan] : []}
          remaining={metaBan ? 0 : 1}
          onSelect={(id) => setMetaBan(metaBan === id ? null : id)}
        />
      ) : null}

      {ready ? (
        <div className="draft__commit">
          <p className="draft__warning">{SEALED_NOTE}</p>
          <button type="button" className="btn btn--primary" onClick={submit}>
            Seal and commit
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The repick (D4/§9.2). Only the slots the opponent's ban actually hit, and only those — the
 * server sends exactly that set, so there is nothing here to decide.
 */
export function RecommitPanel({
  view,
  recommit,
  onAct,
}: {
  view: PlayerView
  recommit: Extract<Action, { type: 'RECOMMIT' }>
  onAct: (payload: PlayerActionPayload) => void
}) {
  const [chosen, setChosen] = useState<Record<number, CharId>>({})
  const pending = recommit.slots.find((s) => chosen[s.index] === undefined)
  const ready = pending === undefined

  return (
    <div className="draft">
      <section className="banner banner--warn">
        <h3 className="banner__title">
          {recommit.slots.length === 1
            ? 'Your opponent banned one of your characters'
            : `Your opponent's ban hit ${recommit.slots.length} of your slots`}
        </h3>
        <p className="banner__body">
          Pick a replacement. Your draft is still hidden — they will not see what you swapped, or
          what you had.
        </p>
      </section>

      {pending ? (
        <CharacterPicker
          label={`Replacement for slot ${pending.index + 1}`}
          pool={pending.pool.filter((id) => !Object.values(chosen).includes(id))}
          roster={view.roster}
          selected={[]}
          remaining={recommit.slots.length - Object.keys(chosen).length}
          onSelect={(id) => setChosen((c) => ({ ...c, [pending.index]: id }))}
        />
      ) : null}

      {ready ? (
        <div className="draft__commit">
          <p className="draft__warning">{SEALED_NOTE}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              onAct({
                type: 'RECOMMIT',
                moduleId: recommit.moduleId,
                seat: view.seat,
                replacements: recommit.slots.map((s) => ({
                  index: s.index,
                  characterId: chosen[s.index]!,
                })),
              })
            }
          >
            Seal replacement{recommit.slots.length > 1 ? 's' : ''}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SelectedStrip({
  picks,
  count,
  roster,
  onRemove,
}: {
  picks: CharId[]
  count: number
  roster: PlayerView['roster']
  onRemove: (id: CharId) => void
}) {
  const byId = new Map(roster.map((c) => [c.id, c]))

  return (
    <ol className="chosen" aria-label="Your picks so far">
      {Array.from({ length: count }, (_, i) => {
        const id = picks[i]
        return (
          <li key={i} className={`chosen__slot ${id ? 'chosen__slot--filled' : ''}`}>
            {id ? (
              <button
                type="button"
                className="chosen__button"
                onClick={() => onRemove(id)}
                aria-label={`Remove ${byId.get(id)?.name ?? id}`}
              >
                <span className="chosen__name">{byId.get(id)?.name ?? id}</span>
                <span className="chosen__x" aria-hidden="true">
                  ×
                </span>
              </button>
            ) : (
              <span className="chosen__empty">Slot {i + 1}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
