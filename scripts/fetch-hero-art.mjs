#!/usr/bin/env node
/**
 * Fetches hero portraits from the publisher's hero index, once.
 *
 * **This is a one-time asset fetch, not a crawler.** It reads `https://dicethrone.com/heroes/`
 * a single time, pairs each card with a roster id, and downloads one thumbnail per hero. Run it
 * again only when the roster gains a character.
 *
 * Three things it does deliberately:
 *
 *   - **Honours `Crawl-delay: 10`** from their robots.txt. That makes a full run take about
 *     eight minutes, which is the correct trade: it is their server.
 *   - **Takes the `199x300` variant**, not the original. The full-size art is ~1.06 MB each and
 *     ~48 MB for the set; the portrait thumbnail is ~111 KB and is more than enough for a card
 *     grid. Smaller for them to serve and smaller for us to deploy.
 *   - **Identifies itself** in the User-Agent, so the traffic is legible in their logs.
 *
 * Art is not required. Any hero without a file renders as initials, which is why deleting
 * `apps/web/public/art/` is a complete and supported way to strip the licensed imagery.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ART_DIR = join(ROOT, 'apps', 'web', 'public', 'art')
const MANIFEST = join(ROOT, 'apps', 'web', 'src', 'generated', 'art.json')

const INDEX = 'https://dicethrone.com/heroes/'
const CRAWL_DELAY_MS = 10_000
const UA = 'banpick-roster-tool/1.0 (personal, non-commercial; one-time hero art fetch)'

/** Where the publisher's slug differs from our permanent id (D14: ids never change). */
const SLUG_TO_ID = {
  'dr-strange': 'doctor-strange',
  'miles-morales-spider-man': 'miles-morales',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, asBuffer = false) {
  const response = await fetch(url, { headers: { 'user-agent': UA } })
  if (!response.ok) return null
  return asBuffer ? Buffer.from(await response.arrayBuffer()) : await response.text()
}

/** WordPress keeps sized variants beside the original: `foo-678x1024.png` -> `foo-199x300.png`. */
function thumbnailUrl(src) {
  if (/-\d+x\d+\.(png|jpe?g)$/i.test(src))
    return src.replace(/-\d+x\d+(\.(png|jpe?g))$/i, '-199x300$1')
  return src.replace(/(\.(png|jpe?g))$/i, '-199x300$1')
}

function parseCards(html) {
  const re =
    /<a class="dt-hero-card" href="https:\/\/dicethrone\.com\/heroes\/([^/"]+)\/"[^>]*>([\s\S]*?)<\/a>/g
  const cards = []
  let m
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]
    const src = /<img[^>]*\ssrc="([^"]+)"/.exec(m[2])?.[1]
    if (src) cards.push({ id: SLUG_TO_ID[slug] ?? slug, slug, src })
  }
  return cards
}

// --- run ---------------------------------------------------------------------------------------

const roster = JSON.parse(readFileSync(join(ROOT, 'roster', 'roster.json'), 'utf8')).characters
const known = new Set(roster.map((c) => c.id))

console.log(`Reading ${INDEX} (once)`)
const html = await get(INDEX)
if (!html) throw new Error('could not read the hero index')

const cards = parseCards(html).filter((c) => known.has(c.id))
const missing = roster.filter((r) => !cards.some((c) => c.id === r.id))

console.log(`${cards.length} of ${roster.length} heroes have a card on the index`)
if (missing.length) console.log(`no art available for: ${missing.map((m) => m.id).join(', ')}`)
console.log(
  `crawl delay ${CRAWL_DELAY_MS / 1000}s — this will take about ${Math.ceil((cards.length * CRAWL_DELAY_MS) / 60000)} minutes\n`,
)

mkdirSync(ART_DIR, { recursive: true })
const manifest = {}
let fetched = 0
let skipped = 0
let bytes = 0

for (const card of cards) {
  const ext = /\.(png|jpe?g)$/i.exec(card.src)?.[1].toLowerCase() ?? 'png'
  const file = `${card.id}.${ext === 'jpeg' ? 'jpg' : ext}`
  manifest[card.id] = `/art/${file}`

  const target = join(ART_DIR, file)
  if (existsSync(target)) {
    skipped++
    continue
  }

  await sleep(CRAWL_DELAY_MS)
  const thumb = thumbnailUrl(card.src)
  let data = await get(thumb, true)
  let from = '199x300'

  if (!data) {
    // No sized variant for this upload; fall back to whatever the index itself references.
    await sleep(CRAWL_DELAY_MS)
    data = await get(card.src, true)
    from = 'original'
  }

  if (!data) {
    console.log(`  ${card.id}: FAILED`)
    delete manifest[card.id]
    continue
  }

  writeFileSync(target, data)
  fetched++
  bytes += data.length
  console.log(`  ${card.id}: ${(data.length / 1024).toFixed(0)} KB (${from})`)
}

mkdirSync(join(ROOT, 'apps', 'web', 'src', 'generated'), { recursive: true })
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `\ndone: ${fetched} fetched, ${skipped} already present, ${(bytes / 1024 / 1024).toFixed(1)} MB added`,
)
console.log(`manifest: ${Object.keys(manifest).length} entries`)
