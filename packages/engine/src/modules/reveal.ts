import type { Action, EventEnvelope, RevealSpec, ResolvedModule, Seat } from '@banpick/types'

import {
  cloneState,
  envelope,
  reject,
  type ApplyResult,
  type ModuleCtx,
  type PhaseModule,
} from '../context.js'
import { revealTag } from '../resolveMode.js'

type RevealModule = RevealSpec & { id: string; roundIndex: ResolvedModule['roundIndex'] }
type Ctx = ModuleCtx<RevealModule>

/**
 * Spec §8 — "Unseal named slices." `bring-ban1`'s gate two.
 *
 * It takes no decision from anybody, so it is entirely SYSTEM-driven: the moment the cursor
 * reaches it, it fires. What makes it a module rather than a flag is that the *event* is what
 * slices point at through `revealedBy` — reveal is data, which is why §7 can express two gates
 * at different times without a phase enum.
 */
export const reveal: PhaseModule<RevealModule> = {
  reads: [],
  writes: [],
  /** A sealed slice whose gate is gone is sealed forever. */
  essential: true,

  awaiting(): Seat[] {
    return []
  },

  legalActions(): Action[] {
    return []
  },

  systemEvent({ state, mod }: Ctx, seq: number): EventEnvelope | null {
    if (state.log.some((e) => e.tag === revealTag(mod.id))) return null
    return envelope(seq, revealTag(mod.id), 'SYSTEM', {
      type: 'REVEAL',
      moduleId: mod.id,
      slices: mod.slices,
    })
  },

  apply({ state, mod }: Ctx, event: EventEnvelope): ApplyResult {
    if (event.payload.type !== 'REVEAL') {
      return reject('WRONG_PHASE', `${mod.id} expects REVEAL, got ${event.payload.type}`)
    }
    const next = cloneState(state)
    next.log.push(event)
    return { ok: true, state: next }
  },

  isComplete({ state, mod }: Ctx): boolean {
    return state.log.some((e) => e.tag === revealTag(mod.id))
  },
}
