/// <reference types="node" />
//
// The only file in the repo that asks for Node's types, and it asks explicitly. The root
// tsconfig sets `types: []` so nothing is ambient — otherwise `packages/engine` would silently
// gain `process`, `Buffer`, and a clock, which is what its no-IO lint exists to prevent.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Roster } from '@banpick/types'

import { loadModeFromSource, type LoadedMode, type LoadOptions } from '@banpick/loader'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')

/**
 * The **real** game roster, on purpose.
 *
 * The engine keeps its own fixture, because rules are not roster data. The loader is the
 * opposite case: §13 roster viability is a claim about the actual shipped roster, so a test
 * that used a fixture would prove nothing about whether the game can be played.
 */
export const GAME_ROSTER = JSON.parse(repoFile('roster/roster.json')) as Roster
export const ROSTER_75 = JSON.parse(repoFile('roster/roster.75.fixture.json')) as Roster

export function modeSource(name: string): string {
  return repoFile(`modes/${name}.yaml`)
}

/**
 * Every mode in `modes/`, discovered rather than listed.
 *
 * The bundle generator used to hold a hardcoded array, which made "adding a mode is config" false
 * in a small but real way: a new YAML file loaded, validated, and then silently failed to reach
 * the worker because nobody remembered to add its name in a second place. Sorted so the generated
 * bundle does not depend on directory order.
 */
export function shippedModeIds(): string[] {
  const dir = fileURLToPath(new URL('../../../modes/', import.meta.url))
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort()
}

/** Loads a shipped mode from `modes/`, against the placeholder roster unless told otherwise. */
export function loadShipped(name: string, opts?: Partial<LoadOptions>): LoadedMode {
  return loadModeFromSource(modeSource(name), `modes/${name}.yaml`, {
    roster: opts?.roster ?? GAME_ROSTER,
  })
}

/**
 * Applies a surgical edit to a shipped mode's YAML.
 *
 * The failure fixtures are **mutations of a known-good file** rather than separate broken files,
 * so each one differs from a passing mode by exactly the thing under test. A hand-written broken
 * file drifts from the real one and eventually fails for a reason nobody intended.
 */
export function mutate(name: string, edits: [find: string, replace: string][]): string {
  let source = modeSource(name)
  for (const [find, replace] of edits) {
    if (!source.includes(find)) {
      throw new Error(`mutate: '${find}' is not in modes/${name}.yaml — the fixture has drifted`)
    }
    source = source.replace(find, replace)
  }
  return source
}

/**
 * Deletes a whole top-level module block by id.
 *
 * Line- and indentation-based rather than a multi-line regex: the blocks contain significant
 * runs of spaces, and a regex that has to count them is unreadable and quietly brittle.
 */
export function removeModule(name: string, moduleId: string): string {
  const lines = modeSource(name).split('\n')
  const isBlockStart = (line: string): boolean => line.startsWith('  - use:')

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (isBlockStart(lines[i]!)) start = i
    if (lines[i]!.trim() === `id: ${moduleId}` && start !== -1) {
      let end = start + 1
      while (end < lines.length && !isBlockStart(lines[end]!)) end++
      return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
    }
  }
  throw new Error(`removeModule: no top-level module '${moduleId}' in modes/${name}.yaml`)
}
