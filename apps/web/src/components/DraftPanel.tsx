import { useEffect, useRef, useState } from 'react'
import type { Action, CharId, PlayerActionPayload, PlayerView } from '@banpick/types'

import { META_BAN_HELP, META_BAN_PROMPT, SEALED_NOTE } from '../copy.js'
import { noteDrafted } from '../favourites.js'
import { play } from '../sound.js'
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
  /** Reports slots filled and whether a ban is chosen, so the opponent's rail fills as you pick. */
  onProgress?: (filled: number, of: number, ban: boolean) => void
  /**
   * Your own picks, for your own rail. **Local only — never sent.**
   *
   * Separate from `onProgress` on purpose: that one goes on the wire and must carry counts alone
   * (§7), while this carries real character ids and must not leave the browser. Two callbacks
   * rather than one object makes it hard to send the wrong one by accident.
   */
  onDraftChange?: (picks: CharId[], metaBan: CharId | null) => void
  /** A take-it-back raised from the board. The counter makes a repeat of the same id distinct. */
  removeRequest?: { id: CharId; n: number }
}

export function DraftPanel({
  view,
  commit,
  onAct,
  onProgress,
  onDraftChange,
  removeRequest,
}: DraftPanelProps) {
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
   * Slots, and the ban, counted separately.
   *
   * They used to be summed into "decisions", which read fine as a sentence and was useless for
   * drawing boxes: "3 of 5" cannot say whether that is three picks or two picks and a ban, and
   * the rail needs to know exactly which slots are full.
   */
  const slotCount = wantsPicks ? commit.picks!.count : 0
  const banChosen = wantsBan && metaBan !== null

  /**
   * What the opponent's meta ban closed off to you.
   *
   * Read off the view rather than derived: `opponent.metaBanPlaced` is *their* ban, and D4 scopes
   * it to you. It is public from gate one, which is exactly why it can be drawn.
   */
  const bannedAgainstYou = view.opponent.metaBanPlaced ? [view.opponent.metaBanPlaced] : []

  /**
   * Reported on **change**, not on render.
   *
   * The callbacks are deliberately not dependencies, and the refs are why they can safely not be:
   * the effect always calls the current one, but only when something actually moves. `Match`
   * passes inline arrows, so including them fired the effect on every render — and because a
   * progress ping re-renders the *opponent*, the two clients drove each other in an unbounded
   * loop that only the server's rate limiter stopped, by locking the seat out of real actions.
   */
  const report = useRef(onProgress)
  report.current = onProgress
  const reportLocal = useRef(onDraftChange)
  reportLocal.current = onDraftChange

  useEffect(() => {
    report.current?.(picks.length, slotCount, banChosen)
  }, [picks.length, slotCount, banChosen])

  useEffect(() => {
    reportLocal.current?.(picks, metaBan)
  }, [picks, metaBan])

  // Removal is driven from the board, so the panel listens for it rather than owning a control.
  // Keyed on the counter, not the id: clicking the same character twice must register twice.
  const removeCount = removeRequest?.n ?? 0
  const removeId = removeRequest?.id ?? ''
  useEffect(() => {
    if (removeCount === 0) return
    play('unpick')
    setPicks((p) => p.filter((x) => x !== removeId))
    setMetaBan((b) => (b === removeId ? null : b))
    // `removeId` is deliberately not a dependency: the counter is what marks a *new* request.
  }, [removeCount])

  const submit = (): void => {
    if (wantsPicks) noteDrafted(picks)
    onAct({
      type: 'COMMIT',
      moduleId: commit.moduleId,
      seat: view.seat,
      // Only what *this* module declared. `bring-ban1` commits twice — a ban, then a draft — and
      // React reconciles by position, so one panel instance serves both phases and its state
      // survives the transition. Sending a leftover ban to the draft module is rejected as
      // WRONG_COMMIT_SHAPE ("draft declares no meta ban") and the player is stuck with no way
      // out. `Match` also keys the panel by module so the state resets; this is the belt to that
      // pair of braces, and it is the layer that cannot be defeated by a reconciliation quirk.
      picks: wantsPicks ? picks : [],
      metaBan: wantsBan ? metaBan : null,
    })
  }

  return (
    <div className="draft">
      {wantsPicks ? (
        <>
          {!picksDone ? (
            <CharacterPicker
              label="Your draft"
              help="Nobody sees these until both of you have committed."
              pool={currentPool.filter((id) => !picks.includes(id))}
              // Bans are shown greyed rather than hidden: the point of banning before the draft
              // is that you choose knowing what is gone. Handed in, never computed (§11.4).
              unavailable={bannedAgainstYou}
              roster={view.roster}
              selected={picks}
              remaining={commit.picks!.count - picks.length}
              onSelect={(id) => {
                play('pick')
                setPicks((p) => [...p, id])
              }}
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
