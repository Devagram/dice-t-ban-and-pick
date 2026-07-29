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
  | {
      type: 'UNDO_LAST_RESULT'
      moduleId: null
      roundIndex: RoundIdx
    }

export type ActionType = Action['type']
