import type { Action, PlayerActionPayload, PlayerView } from '@banpick/types'

import {
  PRIVILEGE_HELP,
  PRIVILEGE_OPTION_HELP,
  PRIVILEGE_PROMPT,
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
    (a) => a.type === 'CHOOSE' || a.type === 'REPORT_RESULT' || a.type === 'UNDO_LAST_RESULT',
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

  return (
    <section className="prompt">
      <h3 className="prompt__title">Who won round {action.roundIndex + 1}?</h3>
      <p className="prompt__help">{REPORT_HELP}</p>
      <div className="prompt__options">
        {action.outcomes.map((outcome) => (
          <button
            key={outcome}
            type="button"
            className="btn btn--option"
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
              {outcome === 'TIE' ? 'A tie' : outcome === view.seat ? 'I won' : 'They won'}
            </span>
            {outcome === 'TIE' ? (
              <span className="btn__sub">Half a point each, and both characters are spent.</span>
            ) : (
              <span className="btn__sub">
                {outcome === view.seat ? `Seat ${view.seat}` : `Seat ${opponent}`}
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  )
}

const OPTION_LABEL: Record<string, string> = {
  DRAFT_PRIVILEGE: 'Draft privilege',
  TURN_ORDER: 'Turn order',
  SELF_FIRST: 'I play first',
  OPPONENT_FIRST: 'They play first',
}
