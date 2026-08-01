/**
 * Who you are, for D28.
 *
 * Two things, and deliberately no more: a name you type, and an id this browser generates once.
 *
 * The **id** is what the no-repeat-ban rule keys on, so renaming yourself keeps your history and
 * typing someone else's name does not inherit theirs. The **name** is a label — self-asserted and
 * never verified, because §1's trust model is friendly opponents and the cost of a wrong one is a
 * wrong caption rather than a bypassed rule.
 *
 * This is not an account. There is no password, nothing crosses devices, and a cleared browser is
 * a new player — which is the same trade D17 already makes for seats, and for the same reason.
 */

const ID_KEY = 'banpick:playerId'
const NAME_KEY = 'banpick:playerName'

export interface Player {
  id: string
  name: string
}

/** The id, generated on first use and kept thereafter. */
export function playerId(): string {
  try {
    const existing = localStorage.getItem(ID_KEY)
    if (existing) return existing
    const fresh = `p_${crypto.randomUUID()}`
    localStorage.setItem(ID_KEY, fresh)
    return fresh
  } catch {
    // Private browsing. A per-session id still works for the match in front of you; it simply
    // will not be recognised next time, which degrades to "no history" rather than to an error.
    return `p_${crypto.randomUUID()}`
  }
}

export function playerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name.trim().slice(0, 40))
  } catch {
    // The name is a label; losing it costs a caption.
  }
}

/** What the seat claim sends. */
export function currentPlayer(): Player {
  return { id: playerId(), name: playerName() }
}
