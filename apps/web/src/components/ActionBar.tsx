import type { Action, PlayerActionPayload, PlayerView, Seat } from '@banpick/types'

import {
  PRIVILEGE_HELP,
  PRIVILEGE_OPTION_HELP,
  PRIVILEGE_PROMPT,
  CONFIRM_HELP,
  REPORT_HELP,
  TURN_ORDER_HELP,
  TURN_ORDER_PROMPT,
} from '../copy.js'

/**
 * **Every control in the match comes from here, and here renders only what the server sent.**
 *
 * §11 non-negotiable 4: *"The client renders `legalActions()` and nothing else. It never
 * computes legality independently."* So there is no `if (round === 2)` in this file and there
 * never can be — the switch is over the shape of what arrived, not over the state of the game.
 *
 * The Phase 4 exit criterion states the consequence as a testable property: *"Disabling
 * JavaScript-side validation entirely changes nothing about which actions succeed."* There is
 * no JavaScript-side validation to disable. If a control is on screen the server offered it; if
 * the server would refuse it, it is not on screen.
 *
 * Slot-targeted actions — BAN and SELECT — are handled by the slot rail instead, because the
 * thing being chosen is a position a player should point at directly. `slotTargets` below is
 * how this component tells the rail which ones the server offered; the rail still invents
 * nothing.
 */

export interface ActionBarProps {
  view: PlayerView
  onAct: (payload: PlayerActionPayload) => void
}

/** Slot choices the server is currently offering, for the rail to render. */
export function slotTargets(view: PlayerView): {
  own: number[]
  opponent: number[]
  ban?: Extract<Action, { type: 'BAN' }>
  select?: Extract<Action, { type: 'SELECT' }>
} {
  const ban = view.legalActions.find((a) => a.type === 'BAN')
  const select = view.legalActions.find((a) => a.type === 'SELECT')
  return {
    own: select ? select.slots : [],
    opponent: ban ? ban.targets.map((t) => t.slotIndex) : [],
    ...(ban ? { ban } : {}),
    ...(select ? { select } : {}),
  }
}

export function ActionBar({ view, onAct }: ActionBarProps) {
  // COMMIT and RECOMMIT open the draft panel; BAN and SELECT belong to the rail. What is left
  // is what this bar draws.
  const inline = view.legalActions.filter(
    (a) =>
      a.type === 'CHOOSE' ||
      a.type === 'REPORT_RESULT' ||
      a.type === 'ROLL' ||
      a.type === 'UNDO_LAST_RESULT',
  )

  if (inline.length === 0) return null

  return (
    <div className="actions">
      {inline.map((action) => {
        switch (action.type) {
          case 'CHOOSE':
            return (
              <ChooseControl key={action.moduleId} action={action} onAct={onAct} seat={view.seat} />
            )
          case 'REPORT_RESULT':
            return <ReportControl key={action.moduleId} action={action} onAct={onAct} view={view} />
          case 'ROLL':
            /*
             * The dice were decided before this button existed — seeded from
             * `(seed, seq, actor, attempt)` the moment the match was created, and unchanged by
             * when or whether anyone presses it. What the press buys is the *moment*: the round
             * used to throw them at you the instant it opened. Both seats have to ask, so the
             * server waits and the reveal belongs to the table.
             */
            return (
              <button
                key={action.moduleId}
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  onAct({
                    type: 'ROLL_READY',
                    moduleId: action.moduleId,
                    roundIndex: action.roundIndex,
                    seat: view.seat,
                  })
                }
              >
                Roll for priority
              </button>
            )
          case 'UNDO_LAST_RESULT':
            return (
              <button
                key="undo"
                type="button"
                className="btn btn--quiet"
                onClick={() =>
                  onAct({
                    type: 'UNDO_LAST_RESULT',
                    roundIndex: action.roundIndex,
                    requestedBy: view.seat,
                  })
                }
              >
                Undo round {action.roundIndex + 1} result
              </button>
            )
          default:
            return null
        }
      })}
    </div>
  )
}

/**
 * Two different decisions wear the same module type, and the copy has to tell them apart:
 * the round-0 privilege choice (D2, and see O5 on why it stopped being a preference) and
 * D24's play-order declaration.
 */
function ChooseControl({
  action,
  onAct,
  seat,
}: {
  action: Extract<Action, { type: 'CHOOSE' }>
  onAct: (payload: PlayerActionPayload) => void
  seat: PlayerView['seat']
}) {
  const isPlayOrder = action.options.includes('SELF_FIRST')

  return (
    <section className="prompt">
      <h3 className="prompt__title">{isPlayOrder ? TURN_ORDER_PROMPT : PRIVILEGE_PROMPT}</h3>
      <p className="prompt__help">{isPlayOrder ? TURN_ORDER_HELP : PRIVILEGE_HELP}</p>
      <div className="prompt__options">
        {action.options.map((option) => (
          <button
            key={option}
            type="button"
            className="btn btn--option"
            onClick={() =>
              onAct({
                type: 'CHOOSE',
                moduleId: action.moduleId,
                roundIndex: action.roundIndex,
                seat,
                option,
              })
            }
          >
            <span className="btn__label">{OPTION_LABEL[option]}</span>
            {PRIVILEGE_OPTION_HELP[option] ? (
              <span className="btn__sub">{PRIVILEGE_OPTION_HELP[option]}</span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  )
}

function ReportControl({
  action,
  onAct,
  view,
}: {
  action: Extract<Action, { type: 'REPORT_RESULT' }>
  onAct: (payload: PlayerActionPayload) => void
  view: PlayerView
}) {
  const opponent = view.seat === 'A' ? 'B' : 'A'

  /*
   * Ordered by who the button means, not by the seat letter.
   *
   * The engine offers outcomes as `['A', 'B', 'TIE']` — absolute seats, which is right for a
   * payload and wrong for a row of buttons. Rendered in that order, seat A gets [I won][They won]
   * and seat B gets [They won][I won]: the same position means opposite things depending on where
   * you are sitting. Anyone who plays a few rounds in one seat and then takes the other clicks the
   * position they learned and reports the opposite of what they meant, which is precisely the kind
   * of mistake `UNDO_LAST_RESULT` exists to clean up and this ordering exists to prevent.
   *
   * "I won" is always first, "they won" second, the tie last.
   */
  const ordered = [...action.outcomes].sort(
    (x, y) => rank(x, view.seat, opponent) - rank(y, view.seat, opponent),
  )

  const nameFor = (outcome: 'A' | 'B' | 'TIE'): string => {
    const player = outcome === view.seat ? view.you.player : view.opponent.player
    return player?.name ? player.name : `Seat ${outcome}`
  }

  /*
   * D38 — the same control, asking a different question.
   *
   * When `confirming` is set the opponent has already said what happened, so this is no longer
   * "who won" but "do you agree". The client is told which it is rather than working it out from
   * the round state: §11 non-negotiable 4 says it renders `legalActions` and never computes
   * legality, and "the other seat has reported, so this is a confirmation" is a rule.
   *
   * Disagreeing is not a separate action. Naming a different outcome *is* the disagreement, which
   * is why the buttons stay the same buttons — the only thing that changes is which one is marked
   * as agreement, and the sentence above them.
   */
  const claimed = action.confirming

  return (
    <section className="prompt">
      <h3 className="prompt__title">
        {claimed === null
          ? `Who won round ${action.roundIndex + 1}?`
          : `They say ${claimed === 'TIE' ? 'it was a tie' : `${nameFor(claimed)} won`}`}
      </h3>
      <p className="prompt__help">{claimed === null ? REPORT_HELP : CONFIRM_HELP}</p>
      <div className="prompt__options">
        {ordered.map((outcome) => (
          <button
            key={outcome}
            type="button"
            className={`btn btn--option ${outcome === view.seat ? 'btn--option-self' : ''} ${
              outcome === claimed ? 'btn--option-agree' : ''
            }`}
            onClick={() =>
              onAct({
                type: 'REPORT_RESULT',
                moduleId: action.moduleId,
                roundIndex: action.roundIndex,
                reportedBy: view.seat,
                outcome,
              })
            }
          >
            <span className="btn__label">
              {outcome === claimed
                ? 'Agree'
                : outcome === 'TIE'
                  ? 'A tie'
                  : outcome === view.seat
                    ? 'I won'
                    : 'They won'}
            </span>
            {outcome === 'TIE' ? (
              <span className="btn__sub">Half a point each, and both characters are spent.</span>
            ) : (
              // The name rather than the seat letter: "I won" is unambiguous, but the line under
              // it is what someone checks when they are not sure, and "Seat B" is only meaningful
              // if you remember which seat you took.
              <span className="btn__sub">{nameFor(outcome)}</span>
            )}
          </button>
        ))}
      </div>
    </section>
  )
}

/** You, then them, then the tie — see the note in `ReportControl`. */
function rank(outcome: 'A' | 'B' | 'TIE', seat: Seat, opponent: Seat): number {
  if (outcome === seat) return 0
  if (outcome === opponent) return 1
  return 2
}

const OPTION_LABEL: Record<string, string> = {
  DRAFT_PRIVILEGE: 'Draft privilege',
  TURN_ORDER: 'Turn order',
  SELF_FIRST: 'I play first',
  OPPONENT_FIRST: 'They play first',
}
