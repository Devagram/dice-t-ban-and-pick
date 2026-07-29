import {
  isRoundIdx,
  type ActorRef,
  type EventTag,
  type ModeDefinition,
  type ModuleSpec,
  type NumberOrParam,
  type ResolvedMode,
  type ResolvedModule,
  type RoundIdx,
  type RoundLoopSpec,
  type RoundModuleSpec,
  type RoundOverride,
  type SelectSpec,
  type SliceName,
} from '@banpick/types'

/**
 * Resolution failures carry a code, so a caller can tell *which* rule broke without matching on
 * a message. Phase 2's loader maps these onto its own stable load-error codes: a mode whose
 * DEFERRED reveal has no gate is a §13 reveal-reachability failure, not a generic bad file, and
 * the failure fixture suite is only meaningful if the two are distinguishable.
 */
export type ResolutionErrorCode =
  | 'PARAMETER_INVALID'
  | 'REVEAL_UNREACHABLE'
  | 'REMOVE_UNKNOWN_MODULE'
  | 'SELECT_ORDER_ARITY'
  | 'SELECT_OVERRIDE_TARGET'
  | 'NESTED_ROUND_LOOP'
  | 'ROUND_INDEX_RANGE'

export class ModeResolutionError extends Error {
  readonly code: ResolutionErrorCode

  constructor(code: ResolutionErrorCode, message: string) {
    super(message)
    this.name = 'ModeResolutionError'
    this.code = code
  }
}

/**
 * Applies host-chosen parameters (D25) and flattens `ROUND_LOOP` into a linear program.
 *
 * Everything downstream depends on this being done here rather than at run time:
 *
 *   - `reduce` becomes a **cursor over an array**, not an interpreter with a nested loop.
 *   - `remove` becomes a **filter**, not a run-time branch. That is what lets §13's
 *     transition-preservation validator be a check on a flat list in Phase 2.
 *   - `stopWhenDecided` becomes an **early terminal**, not loop control.
 *
 * The result is snapshotted into MATCH_CREATED, so a log replays with no mode registry.
 */
export function resolveMode(
  def: ModeDefinition,
  parameters: Record<string, string | number>,
): ResolvedMode {
  const resolved = resolveParameters(def, parameters)

  const flat: ResolvedModule[] = []
  for (const spec of def.modules) {
    if (spec.type === 'ROUND_LOOP') flat.push(...expandRoundLoop(spec, resolved))
    else flat.push(toResolved(spec, null, resolved))
  }

  bindRevealTags(flat)

  return {
    modeId: def.modeId,
    label: interpolate(def.label, resolved),
    parameters: resolved,
    program: flat,
    onTie: def.onTie,
    match: def.match,
    overtime: def.overtime,
  }
}

// --- Parameters (D25) --------------------------------------------------------------------------

function resolveParameters(
  def: ModeDefinition,
  chosen: Record<string, string | number>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(def.parameters)) {
    const value = Object.hasOwn(chosen, name) ? chosen[name]! : spec.default
    if (!spec.values.includes(value)) {
      throw new ModeResolutionError(
        'PARAMETER_INVALID',
        `${def.modeId}.${name} = ${String(value)} is outside its declared values ` +
          `[${spec.values.join(', ')}]. A parameter validated only for its defaults is unvalidated (D25).`,
      )
    }
    out[name] = value
  }
  for (const name of Object.keys(chosen)) {
    if (!Object.hasOwn(def.parameters, name)) {
      throw new ModeResolutionError(
        'PARAMETER_INVALID',
        `${def.modeId} declares no parameter '${name}'`,
      )
    }
  }
  return out
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new ModeResolutionError(
        'PARAMETER_INVALID',
        `label references undeclared parameter '${name}'`,
      )
    }
    return String(params[name])
  })
}

function resolveCount(n: NumberOrParam, params: Record<string, string | number>): number {
  if (typeof n === 'number') return n
  const value = params[n.param]
  if (typeof value !== 'number') {
    throw new ModeResolutionError('PARAMETER_INVALID', `parameter '${n.param}' is not a number`)
  }
  return value
}

// --- Round loop expansion ----------------------------------------------------------------------

function expandRoundLoop(
  loop: RoundLoopSpec,
  params: Record<string, string | number>,
): ResolvedModule[] {
  const out: ResolvedModule[] = []

  for (let i = 0; i < loop.count; i++) {
    if (!isRoundIdx(i))
      throw new ModeResolutionError('ROUND_INDEX_RANGE', `round index ${i} out of range`)
    const override = loop.overrides[i] ?? {}
    const modules = applyOverride(loop.template, override)

    for (const spec of modules) {
      out.push(toResolved(spec, i, params, `${loop.id}.${i}.`))
    }
  }

  return out
}

/**
 * Overrides name modules by **id**, never by type.
 *
 * Spec §9.1 writes round 2's as `remove: [CHOOSE, BAN]`, but the template holds two CHOOSE
 * modules — the privilege choice and D24's `declareOrder` — so removing by type would delete
 * the wrong one and silently drop the play-order decision from the final round. Phase 2's YAML
 * schema should require ids for exactly this reason.
 */
function applyOverride(template: RoundModuleSpec[], o: RoundOverride): RoundModuleSpec[] {
  const removed = new Set(o.remove ?? [])
  for (const id of removed) {
    if (!template.some((m) => m.id === id)) {
      throw new ModeResolutionError(
        'REMOVE_UNKNOWN_MODULE',
        `override removes '${id}', which the template does not define`,
      )
    }
  }

  let modules = template.filter((m) => !removed.has(m.id))

  // D10 — the round-1 inversion replaces the roll and the choice it removed.
  if (o.insert?.length) modules = [...o.insert, ...modules]

  // D11 — the roll assigns turn order directly instead of a CHOOSE that has one real option.
  if (o.rollAssigns) {
    modules = modules.map((m) => (m.type === 'ROLL' ? { ...m, assigns: o.rollAssigns! } : m))
  }

  // §9.3 — R1 hands the *opponent* the last-pick information advantage, as deliberate
  // compensation for R1's stronger ban. At draftCount 3 the counterweight is dead on arrival
  // because the opponent is forced; at 4 it does the job it was written to do.
  if (o.selectOrder) {
    const selects = modules.filter(isSelect)
    if (selects.length !== o.selectOrder.length) {
      throw new ModeResolutionError(
        'SELECT_ORDER_ARITY',
        `selectOrder lists ${o.selectOrder.length} actors but the round has ` +
          `${selects.length} SELECT modules`,
      )
    }
    let n = 0
    modules = modules.map((m) => (isSelect(m) ? { ...m, actor: o.selectOrder![n++]! } : m))
  }

  // D22 — R2 replaces the two sequential selects with one simultaneous hidden pick.
  if (o.select) {
    const first = modules.findIndex(isSelect)
    if (first === -1)
      throw new ModeResolutionError(
        'SELECT_OVERRIDE_TARGET',
        'select override with no SELECT to replace',
      )
    const merged: SelectSpec = {
      type: 'SELECT',
      id: 'select',
      mode: o.select.mode,
      actor: o.select.actor as ActorRef,
      pool: o.select.pool,
    }
    modules = [
      ...modules.slice(0, first).concat([merged]),
      ...modules.slice(first).filter((m) => !isSelect(m)),
    ]
  }

  return modules
}

function isSelect(m: RoundModuleSpec): m is SelectSpec {
  return m.type === 'SELECT'
}

// --- Spec -> resolved ---------------------------------------------------------------------------

function toResolved(
  spec: ModuleSpec,
  roundIndex: RoundIdx | null,
  params: Record<string, string | number>,
  prefix = '',
): ResolvedModule {
  const id = `${prefix}${spec.id}`

  if (spec.type === 'ROUND_LOOP') {
    throw new ModeResolutionError('NESTED_ROUND_LOOP', 'nested ROUND_LOOP is not supported')
  }

  if (spec.type === 'SIMULTANEOUS_COMMIT') {
    return {
      type: 'SIMULTANEOUS_COMMIT',
      id,
      roundIndex,
      commits: {
        picks: spec.commits.picks
          ? { count: resolveCount(spec.commits.picks.count, params), pool: spec.commits.picks.pool }
          : null,
        metaBan: spec.commits.metaBan,
      },
      reveal: spec.reveal,
      revealTags: { picks: null, metaBan: null }, // bound in bindRevealTags
    }
  }

  if (spec.type === 'CONDITIONAL_RECOMMIT') {
    return { ...spec, id, roundIndex, revealTag: null }
  }

  return { ...spec, id, roundIndex }
}

// --- Reveal binding ------------------------------------------------------------------------------

/** The tag an event carries when a module opens its slices. */
export function revealTag(moduleId: string): EventTag {
  return `${moduleId}:reveal`
}

const SLICE_OF: Record<'picks' | 'metaBan', SliceName> = { picks: 'slots', metaBan: 'metaBan' }

/**
 * Resolves `Slice.revealedBy` for every sealed write, so a commit can seal itself with the tag
 * that will open it rather than leaving the question until reveal time.
 *
 * IMMEDIATE opens at the module's own gate. DEFERRED must be picked up by a downstream REVEAL
 * naming that slice — and if none does, that is spec §13's *reveal reachability* failure. It
 * throws here in Phase 1; Phase 2's loader turns it into a load-time error code.
 */
function bindRevealTags(program: ResolvedModule[]): void {
  for (let i = 0; i < program.length; i++) {
    const mod = program[i]!
    const downstream = program.slice(i + 1)

    if (mod.type === 'SIMULTANEOUS_COMMIT') {
      for (const kind of ['picks', 'metaBan'] as const) {
        if (mod.commits[kind] === null) continue
        const timing = mod.reveal[kind]
        if (timing === 'IMMEDIATE') {
          mod.revealTags[kind] = revealTag(mod.id)
        } else if (timing === 'DEFERRED') {
          mod.revealTags[kind] = findRevealer(downstream, SLICE_OF[kind], mod.id, kind)
        }
      }
    }

    if (mod.type === 'CONDITIONAL_RECOMMIT' && mod.hidden) {
      mod.revealTag = findRevealer(downstream, 'slots', mod.id, 'picks')
    }
  }
}

function findRevealer(
  downstream: ResolvedModule[],
  slice: SliceName,
  moduleId: string,
  kind: string,
): EventTag {
  const revealer = downstream.find((m) => m.type === 'REVEAL' && m.slices.includes(slice))
  if (!revealer) {
    throw new ModeResolutionError(
      'REVEAL_UNREACHABLE',
      `${moduleId} defers '${kind}' but no downstream REVEAL opens '${slice}'. ` +
        'A sealed slice with no gate is sealed forever (spec §13, reveal reachability).',
    )
  }
  return revealTag(revealer.id)
}
