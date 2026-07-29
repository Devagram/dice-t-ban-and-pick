import type { ResolvedModule } from '@banpick/types'

import type { PhaseModule } from '../context.js'
import { simultaneousCommit } from './simultaneousCommit.js'
import { conditionalRecommit } from './conditionalRecommit.js'
import { reveal } from './reveal.js'
import { roll } from './roll.js'
import { choose } from './choose.js'
import { assign } from './assign.js'
import { ban } from './ban.js'
import { select } from './select.js'
import { reportResult } from './reportResult.js'

/**
 * Spec §8's module table, as data.
 *
 * `ROUND_LOOP` is absent on purpose: it is a resolution-time construct, expanded flat before
 * the engine ever runs (see resolveMode.ts). A module that exists only to loop has no reduce
 * semantics to give.
 */
const REGISTRY = {
  SIMULTANEOUS_COMMIT: simultaneousCommit,
  CONDITIONAL_RECOMMIT: conditionalRecommit,
  REVEAL: reveal,
  ROLL: roll,
  CHOOSE: choose,
  ASSIGN: assign,
  BAN: ban,
  SELECT: select,
  REPORT_RESULT: reportResult,
} as const

export function moduleFor(mod: ResolvedModule): PhaseModule {
  const impl = REGISTRY[mod.type as keyof typeof REGISTRY]
  if (!impl) throw new TypeError(`no phase module implements ${mod.type}`)
  return impl as PhaseModule
}

export { REGISTRY }
