#!/usr/bin/env node
/**
 * D18 / G5 — the package boundary check.
 *
 * `@banpick/engine` holds reduce, legalActions, and project. Spec §11 non-negotiable 4 says
 * the client renders legalActions() and nothing else, and D18 makes that a property rather
 * than a promise by not shipping the client the code that could compute legality.
 *
 * npm workspaces hoist into a single node_modules, so nothing at runtime stops anyone from
 * importing the engine anywhere. This script is therefore the boundary, not a warning about
 * it: it fails the build.
 *
 * Two things are checked, because a declared dependency and an actual import can disagree:
 *
 *   1. Manifest — no workspace outside ENGINE_CONSUMERS may declare @banpick/engine.
 *   2. Source   — no file outside those workspaces may import from it, even undeclared
 *                 (which hoisting makes possible).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Only these workspaces may hold the rules engine. Adding one is a design decision.
 *
 * `packages/engine` is here because a package importing itself by name is how its own tests
 * reach it — they exercise the same entry point the Durable Object will, rather than reaching
 * into `src/` behind the export map.
 *
 * `packages/loader` is here on purpose. D18's concern is the *client*: if it can compute
 * legality it eventually will, and then two implementations of the rules drift. The loader is a
 * build-time tool in the same trust domain as the Durable Object, and it needs `resolveMode` and
 * the module metadata to validate a mode at all. Validating config against the real engine is
 * the point — a loader with its own idea of what a module does would be the second
 * implementation D18 exists to prevent.
 */
const ENGINE_CONSUMERS = new Set(['packages/engine', 'packages/loader', 'apps/worker'])

const WORKSPACE_GLOBS = ['packages', 'apps']
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.wrangler'])

const IMPORT_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@banpick\/engine(?:\/[^'"]*)?)['"]/g

const failures = []

function listWorkspaces() {
  const found = []
  for (const group of WORKSPACE_GLOBS) {
    const dir = join(ROOT, group)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue // the group has no members yet — packages/loader and apps/* arrive at their phases
    }
    for (const name of entries) {
      const abs = join(dir, name)
      if (!statSync(abs).isDirectory()) continue
      try {
        statSync(join(abs, 'package.json'))
      } catch {
        continue
      }
      found.push({ id: `${group}/${name}`, abs })
    }
  }
  return found
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(abs)
    else if (SOURCE_EXT.test(entry.name)) yield abs
  }
}

const workspaces = listWorkspaces()

for (const ws of workspaces) {
  const allowed = ENGINE_CONSUMERS.has(ws.id)

  // 1. Manifest
  const manifest = JSON.parse(readFileSync(join(ws.abs, 'package.json'), 'utf8'))
  const declared = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  }
  if (!allowed && Object.hasOwn(declared, '@banpick/engine')) {
    failures.push(`${ws.id}/package.json declares a dependency on @banpick/engine`)
  }

  // 2. Source
  if (allowed) continue
  for (const file of walk(ws.abs)) {
    const src = readFileSync(file, 'utf8')
    IMPORT_RE.lastIndex = 0
    let match
    while ((match = IMPORT_RE.exec(src)) !== null) {
      const line = src.slice(0, match.index).split('\n').length
      failures.push(`${relative(ROOT, file).split(sep).join('/')}:${line} imports ${match[1]}`)
    }
  }
}

if (failures.length > 0) {
  console.error('\nD18 package boundary violated:\n')
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(
    `\n@banpick/engine may only be imported by: ${[...ENGINE_CONSUMERS].join(', ')}.` +
      '\nEverything else gets @banpick/types. See spec D18 and docs/SPEC-GAPS.md G5.\n',
  )
  process.exit(1)
}

const scanned = workspaces.map((w) => w.id).join(', ') || '(none yet)'
console.log(`D18 boundary OK — checked ${workspaces.length} workspace(s): ${scanned}`)
