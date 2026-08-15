import type { CharId } from './character.js'
import type { RoundIdx, SlotIdx } from './slot.js'
import type { ChoiceOption, RoundBanTarget, RoundOutcome } from './event.js'

/**
 * What a seat may do right now (spec §11 non-negotiable 4: the client renders `legalActions()`
 * and nothing else).
 *
 * An action **describes an option space**; it is not one concrete submission. Drafting 4 from
 * ~75 is 1.2 million combinations, so enumerating them is not an option — and it would be the
 * wrong shape anyway. `pool` is what the client renders a picker over; `reduce` is what
 * decides whether the resulting event was legal. The client never gets a second opinion.
 */
export type Action =
  | {
      type: 'FILL_SEAT'
      moduleId: null
    }
  | {
      type: 'COMMIT'
      moduleId: string
      picks: { count: number; poolBySlot: CharId[][] } | null
      metaBan: { count: 1; pool: CharId[] } | null
    }
  | {
      type: 'RECOMMIT'
      moduleId: string
      /** Only the slots the trigger matched. Each carries its own pool — see §6 on why. */
      slots: { index: SlotIdx; pool: CharId[] }[]
    }
  | {
      type: 'CHOOSE'
      moduleId: string
      roundIndex: RoundIdx
      options: ChoiceOption[]
    }
  | {
      type: 'BAN'
      moduleId: string
      roundIndex: RoundIdx
      tier: 'ROUND'
      targets: RoundBanTarget[]
    }
  | {
      type: 'SELECT'
      moduleId: string
      roundIndex: RoundIdx
      slots: SlotIdx[]
    }
  | {
      type: 'REPORT_RESULT'
      moduleId: string
      roundIndex: RoundIdx
      outcomes: RoundOutcome[]
    }
  /**
   * Take hold of your own die.
   *
   * The roll is still decided entirely by the server — seeded, and already determined by
   * `(seed, seq, actor, attempt)` before either player clicks. This action does not produce the
   * number; it says *go*. Both seats must say it before the dice resolve, which is what makes
   * the moment shared rather than something the round does at you.
   */
  | {
      type: 'ROLL'
      moduleId: string
      roundIndex: RoundIdx
    }
  | {
      type: 'UNDO_LAST_RESULT'
      moduleId: null
      roundIndex: RoundIdx
    }
  /**
   * D33 — correct a round that was reported wrong, however long ago.
   *
   * Distinct from `UNDO_LAST_RESULT`, which is D15's fat-finger window: that one covers the
   * result you just entered and shuts as soon as the next round starts. This one covers the
   * mistake you notice in round 3 about round 1, which the window was never going to catch.
   *
   * `rounds` carries every amendable round with the outcomes each will accept, because the
   * outcomes are not uniform — D30's overtime round forbids the tie the others allow, and the
   * client is not allowed to know that rule (§11 non-negotiable 4).
   */
  | {
      type: 'AMEND_RESULT'
      moduleId: null
      rounds: { roundIndex: RoundIdx; current: RoundOutcome; outcomes: RoundOutcome[] }[]
    }

export type ActionType = Action['type']
