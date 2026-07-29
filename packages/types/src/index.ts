/**
 * `@banpick/types` — the wire contract.
 *
 * This is the **only** package the client ever imports (D18 / G5). It holds no rules: nothing
 * here can decide whether an action is legal, which is what makes §11's thin-client rule a
 * property of the build rather than a promise in a document.
 */

export * from './seat.js'
export * from './character.js'
export * from './slot.js'
export * from './slice.js'
export * from './ruleset.js'
export * from './event.js'
export * from './mode.js'
export * from './state.js'
export * from './action.js'
export * from './view.js'
export * from './protocol.js'
export * from './canonical.js'
