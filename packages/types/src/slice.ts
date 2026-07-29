import type { Seat } from './seat.js'
import type { EventTag } from './event.js'

/**
 * Spec §7. **Visibility is per slice, not per phase.** A single phase enum cannot express
 * `bring-ban1`, which has two reveal gates at different times.
 *
 * A slice is visible to a seat when it is public (`owner === null`), owned by that seat, or
 * unsealed by an event that has already been appended (`revealedBy`).
 */
export interface Slice<T> {
  value: T
  /** `null` means public. */
  owner: Seat | null
  /** The event tag that unseals this slice. `null` means it never opens on its own. */
  revealedBy: EventTag | null
}

/**
 * The state slices a phase module may read or write. The loader (Phase 2) checks that every
 * module's read set is satisfied by an upstream write (spec §13, slice dependency).
 */
export type SliceName = 'slots' | 'metaBan' | 'selection'

export function publicSlice<T>(value: T): Slice<T> {
  return { value, owner: null, revealedBy: null }
}
