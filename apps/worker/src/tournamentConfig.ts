/// <reference types="@cloudflare/workers-types" />

import type { BracketFormat, SeedingMode, Slot } from '@banpick/bracket'
import type { Ruleset } from '@banpick/types'

import {
  defaultParameters,
  findMode,
  findVariant,
  rulesetFor,
  type BundledVariant,
} from './modes.js'

/**
 * **D37 — which mode each bracket position is played under.**
 *
 * The requirement was "any game mode can make up a bracket, the finals can differ, the losers
 * bracket can differ". Shaped as a **default plus overrides**, which is the idiom `ROUND_LOOP`
 * already uses for exactly the same job one layer down — a second way of saying "mostly this,
 * except here" would be a second thing to learn for no gain.
 */

/**
 * Override keys are **bracket positions, not slot ids**.
 *
 * Per-slot overrides would let an organizer say "W2M3 is a Bo1", which sounds more expressive and
 * is a trap: the slot ids depend on the entrant count, so a config written for eight people means
 * something different for nine, and silently. Positions are stable under a change of field size.
 */
export type BracketPosition =
  'WINNERS' | 'LOSERS' | 'WINNERS_FINAL' | 'LOSERS_FINAL' | 'GRAND_FINAL' | 'GRAND_FINAL_RESET'

export const BRACKET_POSITIONS: readonly BracketPosition[] = [
  'WINNERS',
  'LOSERS',
  'WINNERS_FINAL',
  'LOSERS_FINAL',
  'GRAND_FINAL',
  'GRAND_FINAL_RESET',
]

/** One `(modeId, parameters)` pair, before it has been checked against the bundle. */
export interface ModeChoice {
  modeId: string
  parameters?: Record<string, string | number>
}

export interface TournamentConfigInput {
  format?: BracketFormat
  seeding?: SeedingMode
  grandFinalReset?: boolean
  /** D5 — organizer-set for the whole tournament, and no room's host may override it. */
  globalBanned?: string[]
  /** D28 — the organizer's answer, applied to every match in the event. */
  allowRepeatBans?: boolean
  default?: ModeChoice
  overrides?: Partial<Record<BracketPosition, ModeChoice>>
}

/** A position's mode, resolved to a validated variant and its snapshotted ruleset. */
export interface ResolvedPosition {
  modeId: string
  parameters: Record<string, string | number>
  ruleset: Ruleset
}

export interface ResolvedTournamentConfig {
  format: BracketFormat
  seeding: SeedingMode
  grandFinalReset: boolean
  globalBanned: string[]
  allowRepeatBans: boolean
  /** Every position, resolved. Not a sparse map — see `resolveConfig`. */
  positions: Record<BracketPosition, ResolvedPosition>
}

export class ConfigError extends Error {
  readonly code: 'UNKNOWN_MODE' | 'UNKNOWN_VARIANT' | 'BAD_FORMAT' | 'BAD_CONFIG'
  readonly at: string

  constructor(code: ConfigError['code'], at: string, message: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.at = at
  }
}

/**
 * Which position a slot sits at.
 *
 * Derived from the bracket rather than stored per slot, so a re-seeded or resized tournament
 * cannot end up with positions that were labelled for a different field.
 */
export function positionOf(
  slot: Slot,
  winnersRounds: number,
  losersRounds: number,
): BracketPosition {
  if (slot.side === 'GRAND_FINAL') return slot.round === 2 ? 'GRAND_FINAL_RESET' : 'GRAND_FINAL'
  if (slot.side === 'WINNERS') return slot.round === winnersRounds ? 'WINNERS_FINAL' : 'WINNERS'
  return slot.round === losersRounds ? 'LOSERS_FINAL' : 'LOSERS'
}

/**
 * The fallback chain, and the one part of it that is not obvious.
 *
 * `GRAND_FINAL_RESET` falls back to `GRAND_FINAL`, **not** to the tournament default. A reset is a
 * continuation of the grand final, and falling through to the default would play the decider under
 * different rules from the match it is deciding — which nobody would ask for and everybody would
 * be surprised by. Every other position falls back to the default directly.
 */
function chainFor(position: BracketPosition): BracketPosition[] {
  switch (position) {
    case 'GRAND_FINAL_RESET':
      return ['GRAND_FINAL_RESET', 'GRAND_FINAL']
    case 'WINNERS_FINAL':
      return ['WINNERS_FINAL', 'WINNERS']
    case 'LOSERS_FINAL':
      return ['LOSERS_FINAL', 'LOSERS']
    default:
      return [position]
  }
}

/**
 * Resolves the whole config at **creation**, not at provisioning.
 *
 * Every position is resolved even if no match ever reaches it, and that is the point: §13's whole
 * argument is that a mode which cannot work should fail at deploy rather than mid-match, and D25
 * validates every declared parameter combination rather than only the defaults. A tournament that
 * fails at the semi-final because a mode id was misspelled in the losers-bracket override is the
 * same failure one layer up — except now it happens in front of eight people who have already
 * played.
 *
 * The resolved rulesets are snapshotted into the creation record (§11 non-negotiable 2), so a
 * tournament that starts under one ruleset cannot silently finish under another because someone
 * edited a mode file and redeployed mid-event.
 */
export function resolveConfig(
  input: TournamentConfigInput,
  rosterVersion: string,
): ResolvedTournamentConfig {
  const format = input.format ?? 'SINGLE_ELIMINATION'
  if (format !== 'SINGLE_ELIMINATION' && format !== 'DOUBLE_ELIMINATION') {
    throw new ConfigError('BAD_FORMAT', 'format', `unknown bracket format '${String(format)}'`)
  }

  const seeding = input.seeding ?? 'AS_ENTERED'
  if (seeding !== 'AS_ENTERED' && seeding !== 'RANDOM' && seeding !== 'MANUAL') {
    throw new ConfigError('BAD_CONFIG', 'seeding', `unknown seeding mode '${String(seeding)}'`)
  }

  const globalBanned = Array.isArray(input.globalBanned) ? input.globalBanned.map(String) : []
  const allowRepeatBans = input.allowRepeatBans === true
  const fallback: ModeChoice = input.default ?? { modeId: 'base' }

  const resolve = (choice: ModeChoice, at: string): ResolvedPosition => {
    if (typeof choice?.modeId !== 'string' || !choice.modeId) {
      throw new ConfigError('BAD_CONFIG', at, 'a mode choice needs a modeId')
    }
    const mode = findMode(choice.modeId)
    if (!mode) {
      throw new ConfigError('UNKNOWN_MODE', at, `no mode '${choice.modeId}' ships with this build`)
    }
    // Absent parameters mean the mode's declared defaults, not an empty object — a parameterless
    // mode and a mode whose parameters were omitted must both resolve, and only one of them
    // matches `{}` literally.
    const parameters = choice.parameters ?? defaultParameters(mode)
    const variant = findVariant(mode, parameters)
    if (!variant) {
      throw new ConfigError(
        'UNKNOWN_VARIANT',
        at,
        `'${choice.modeId}' declares no validated variant for ` +
          `${JSON.stringify(parameters)}. Every offerable combination is enumerated at build ` +
          'time (D25); this one was not.',
      )
    }
    return {
      modeId: mode.modeId,
      parameters: variant.parameters,
      ruleset: rulesetFor(
        variant as BundledVariant,
        rosterVersion,
        globalBanned,
        allowRepeatBans,
        // D38 — every match in a tournament needs both seats to agree. Set here, at the one place
        // that knows a match belongs to a bracket, so casual play is untouched by construction
        // rather than by a conditional somewhere downstream.
        'BOTH_SEATS',
      ),
    }
  }

  const overrides = input.overrides ?? {}
  for (const key of Object.keys(overrides)) {
    if (!BRACKET_POSITIONS.includes(key as BracketPosition)) {
      throw new ConfigError(
        'BAD_CONFIG',
        `overrides/${key}`,
        `'${key}' is not a bracket position. Valid: ${BRACKET_POSITIONS.join(', ')}`,
      )
    }
  }

  const positions = {} as Record<BracketPosition, ResolvedPosition>
  for (const position of BRACKET_POSITIONS) {
    const chain = chainFor(position)
    const found = chain.map((step) => overrides[step]).find((c) => c !== undefined)
    const at = found ? `overrides/${chain.find((step) => overrides[step])!}` : 'default'
    positions[position] = resolve(found ?? fallback, at)
  }

  return {
    format,
    seeding,
    // D40 — defaults on, and forced off where there is no losers bracket to reset from.
    grandFinalReset: format === 'DOUBLE_ELIMINATION' && (input.grandFinalReset ?? true),
    globalBanned,
    allowRepeatBans,
    positions,
  }
}
