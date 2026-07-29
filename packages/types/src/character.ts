/**
 * Spec §5 and §16 (D14).
 *
 * `id` is permanent identity — it appears in every event log ever written, so it is never
 * reused and never deleted. `name` and `blurb` are display only and free to change; a rename
 * makes an old log render the new name, which is correct, because it is the same character.
 */
export type CharId = string

export interface Character {
  /** Permanent. Never reused for a different character (roster/README.md rule 1). */
  id: CharId
  /** Display only. Free to change. */
  name: string
  /** Display only. */
  blurb: string
  /**
   * Retire, never delete (rule 2). A deleted character breaks replay of every match that
   * referenced it: the log holds an ID that no longer resolves.
   */
  status: 'ACTIVE' | 'RETIRED'
}

export interface Roster {
  /** `YYYY.MM.DD-N`. Bumped when the *draftable* set changes; renames do not bump it. */
  rosterVersion: string
  characters: Character[]
}

/** Spec §6 — `activeRoster` is the base set of every pool expression. */
export function activeRoster(roster: Roster): CharId[] {
  return roster.characters.filter((c) => c.status === 'ACTIVE').map((c) => c.id)
}
