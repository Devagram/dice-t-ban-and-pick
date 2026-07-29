#!/usr/bin/env node
/**
 * The single outbound choke point.
 *
 * The delivery plan asks for this by name: *"Every frame leaving the DO passes through one
 * function that calls `project()`. Not two functions. One. Grep for the WebSocket send API in
 * CI and fail the build if it appears anywhere else."*
 *
 * The reason is §7. Redaction is a property of `project()`, and a property enforced in two
 * places is a property that will eventually hold in only one of them — the second sender is
 * always the one written in a hurry, for a "quick status ping", by someone who did not know the
 * rule existed. This script is how they find out.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKER_SRC = join(ROOT, 'apps', 'worker', 'src')

/** The only file permitted to touch the WebSocket send API. */
const CHOKE_POINT = 'outbound.ts'

/** `socket.send(...)`, `ws.send(...)`, `server.send(...)` — any receiver. */
const SEND_RE = /\.\s*send\s*\(/g

/**
 * `project()` is the redaction boundary itself, so it may only be called where the frame is
 * built. A caller that projects somewhere else is one refactor from serializing the result.
 */
const PROJECT_RE = /\bproject\s*\(/g

const failures = []

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // apps/worker does not exist until Phase 3
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'generated' && entry.name !== 'node_modules') yield* walk(abs)
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      yield abs
    }
  }
}

/**
 * Blanks out comments and string bodies, preserving line numbers.
 *
 * Without this the check fires on its own explanations — every file here documents the rule it
 * follows, and "a full `project()` resync" in a doc comment is not a call. Blanking rather than
 * deleting keeps reported line numbers honest.
 *
 * Regex literals are not tracked. The worker contains none containing `//` or `.send(`, and a
 * state machine that gets regex-vs-division wrong would fail in the dangerous direction — so
 * the limitation is stated rather than approximated.
 */
function stripCommentsAndStrings(src) {
  let out = ''
  let i = 0
  const blank = (text) => text.replace(/[^\n]/g, ' ')

  while (i < src.length) {
    const two = src.slice(i, i + 2)

    if (two === '//') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      out += blank(src.slice(i, stop))
      i = stop
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += blank(src.slice(i, stop))
      i = stop
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i]
      let j = i + 1
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1
      out += src[i] + blank(src.slice(i + 1, j)) + (src[j] ?? '')
      i = j + 1
    } else {
      out += src[i]
      i++
    }
  }
  return out
}

let scanned = 0

for (const file of walk(WORKER_SRC)) {
  scanned++
  const name = file.split(sep).pop()
  if (name === CHOKE_POINT) continue

  const src = stripCommentsAndStrings(readFileSync(file, 'utf8'))
  const where = relative(ROOT, file).split(sep).join('/')

  for (const [re, what] of [
    [SEND_RE, 'calls a .send() method'],
    [PROJECT_RE, 'calls project()'],
  ]) {
    re.lastIndex = 0
    let hit
    while ((hit = re.exec(src)) !== null) {
      const line = src.slice(0, hit.index).split('\n').length
      failures.push(`${where}:${line} ${what}`)
    }
  }
}

if (failures.length > 0) {
  console.error('\nOutbound choke point violated:\n')
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(
    `\nEvery frame leaving the Durable Object goes through apps/worker/src/${CHOKE_POINT}, which` +
      '\nis the only place that calls project(). §7 redaction is a property of that function, and' +
      '\na second sender is how it stops being one.\n',
  )
  process.exit(1)
}

console.log(`Outbound choke point OK — ${scanned} worker file(s), all sends via ${CHOKE_POINT}`)
