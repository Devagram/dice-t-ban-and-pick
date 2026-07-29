import type { CharId } from '@banpick/types'

/**
 * Favourites and recents.
 *
 * Open item O6 makes these a **requirement, not polish**: *"Drafting 4 from ~75 is a
 * search-and-filter problem, not a grid. Text search, favourites, and recents are requirements,
 * not polish."*
 *
 * There is a second reason, and it is the more interesting one. At a 75-character roster the
 * meta ban hits about 5.3% of the time under uniform drafting — the mode only works because
 * *people do not draft uniformly*. Favourites are the mechanism by which they don't. Making
 * them easy to reach is what turns "did they bring this?" into "what do they always play?",
 * which is the mode O6 says we actually have.
 *
 * Local to the device on purpose. A shared favourites list would be a tell.
 */

const FAVOURITES_KEY = 'banpick:favourites'
const RECENTS_KEY = 'banpick:recents'
const RECENTS_LIMIT = 8

function read(key: string): CharId[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as CharId[]) : []
  } catch {
    return []
  }
}

function write(key: string, ids: CharId[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // Private browsing. Search still works, which is the part that cannot be done without.
  }
}

export function getFavourites(): CharId[] {
  return read(FAVOURITES_KEY)
}

export function toggleFavourite(id: CharId): CharId[] {
  const current = getFavourites()
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  write(FAVOURITES_KEY, next)
  return next
}

export function getRecents(): CharId[] {
  return read(RECENTS_KEY)
}

/** Most recent first, deduplicated, capped. */
export function noteDrafted(ids: CharId[]): void {
  const next = [...ids, ...getRecents().filter((id) => !ids.includes(id))].slice(0, RECENTS_LIMIT)
  write(RECENTS_KEY, next)
}
