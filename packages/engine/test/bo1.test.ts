import { bo1Bring3Ban1Mode, legalActions, project } from '@banpick/engine'
import { describe, expect, it } from 'vitest'

import {
  apply,
  atModule,
  awaiting,
  commitAll,
  currentAction,
  driveUntil,
  materialize,
  playMatch,
  startMatch,
  SEATS,
  type MatchOptions,
} from './helpers.js'

/**
 * **D36 — the single game, and the two engine assumptions it broke.**
 *
 * The mode itself is config. What is being tested here is that the engine stopped assuming things
 * it had no right to assume:
 *
 *   1. **Regulation was three rounds, in a constant.** A one-round mode was allocated three round
 *      states regardless, two of which could never be played — and an unplayed round is
 *      indistinguishable in the record from one that was played and tied, so they reached the
 *      permanent match history as real-looking blanks.
 *   2. **A round had one banner.** `BAN` recorded a single `{ by, target }` and treated the
 *      existence of any BAN event as completion, so a second seat would never have been asked.
 *
 * The redaction case is the one worth being most careful about, because it is the only new way
 * to leak: a ban writes `bannedInRound` onto an opponent slot, and `slots` is public.
 */

const bo1 = (over: Partial<MatchOptions> = {}) => startMatch({ mode: bo1Bring3Ban1Mode, ...over })

describe('a one-round match', () => {
  it('allocates exactly one round, not three with two blanks', () => {
    const state = bo1()
    expect(state.rounds).toHaveLength(1)
    expect(state.rounds[0]!.index).toBe(0)
  })

  it('completes after that round and scores it', () => {
    const done = playMatch(bo1(), ['A'])
    expect(done.status).toBe('COMPLETE')
    expect(done.outcome).toBe('A')
    expect(done.seats.A.score).toBe(1)
    expect(done.seats.B.score).toBe(0)
  })

  it('is a drawn match when the single round ties', () => {
    // The owner's call: a tied Bo1 is a draw rather than a decider, which is what HALF_POINT has
    // meant since D21. Overtime is off precisely so this does not silently become a Bo2.
    const done = playMatch(bo1(), ['TIE'])
    expect(done.status).toBe('COMPLETE')
    expect(done.outcome).toBe('DRAW')
    expect(done.seats.A.score).toBe(0.5)
    expect(done.seats.B.score).toBe(0.5)
  })

  it('never shows an overtime round, because there is none to reach', () => {
    const view = project(playMatch(bo1(), ['TIE']), 'A')
    expect(view.rounds).toHaveLength(1)
    expect(view.rounds.every((r) => !r.overtime)).toBe(true)
  })

  it('leaves the Bo3 modes counting three rounds exactly as before', async () => {
    // The regulation count moved from a constant onto the mode; the point is that it did not
    // change value for anything that already existed.
    const { baseMode } = await import('@banpick/engine')
    expect(startMatch({ mode: baseMode, draftCount: 4 }).rounds).toHaveLength(4) // 3 + overtime
    expect(startMatch({ mode: baseMode, draftCount: 3 }).rounds).toHaveLength(4)
  })
})

describe('both seats banning at once', () => {
  const toBan = () => driveUntil(commitAll(bo1()), atModule('rounds.0.ban'))

  it('asks both seats, not just one', () => {
    const state = toBan()
    expect(awaiting(state).sort()).toEqual(['A', 'B'])
  })

  it('offers each seat the other seat’s three slots', () => {
    const state = toBan()
    for (const seat of SEATS) {
      const ban = currentAction(state, seat, 'BAN')!
      expect(ban.targets).toHaveLength(3)
      // D3 — a ban targets an opponent slot, so every target names the other seat.
      expect(ban.targets.every((t) => t.seat !== seat)).toBe(true)
    }
  })

  it('still wants the second seat after the first has banned', () => {
    let state = toBan()
    const first = currentAction(state, 'A', 'BAN')!
    state = apply(state, 'A', materialize(first, 'A'))

    // The old module treated any BAN event as completion, which would have skipped B entirely.
    expect(awaiting(state)).toEqual(['B'])
    expect(currentAction(state, 'B', 'BAN')).not.toBeNull()
  })

  it('refuses a second ban from the same seat', () => {
    let state = toBan()
    const first = currentAction(state, 'A', 'BAN')!
    state = apply(state, 'A', materialize(first, 'A'))
    expect(currentAction(state, 'A', 'BAN')).toBeNull()
  })

  it('records both bans against the seats that placed them', () => {
    let state = toBan()
    for (const seat of SEATS) {
      state = apply(state, seat, materialize(currentAction(state, seat, 'BAN')!, seat))
    }
    const round = state.rounds[0]!
    expect(round.ban.A.value).not.toBeNull()
    expect(round.ban.B.value).not.toBeNull()
  })

  it('leaves each seat a real choice of two', () => {
    let state = toBan()
    for (const seat of SEATS) {
      state = apply(state, seat, materialize(currentAction(state, seat, 'BAN')!, seat))
    }
    state = driveUntil(state, atModule('rounds.0.select'))
    for (const seat of SEATS) {
      // Three brought minus one banned. At two it would auto-commit under D26 and the ban would
      // be choosing the opponent's character for them.
      expect(currentAction(state, seat, 'SELECT')!.slots).toHaveLength(2)
    }
  })
})

describe('a hidden ban stays hidden', () => {
  /** Drives to the ban, then places only A's. */
  const oneBanPlaced = () => {
    const state = driveUntil(commitAll(bo1()), atModule('rounds.0.ban'))
    return apply(state, 'A', materialize(currentAction(state, 'A', 'BAN')!, 'A'))
  }

  it('does not tell the victim which of their characters was hit', () => {
    const state = oneBanPlaced()
    const bView = project(state, 'B')

    // §7 is asserted on the serialized string, not the object: an object test passes while a
    // `toJSON` leaks. B's own slots are public — it is the *flag* that must not be there yet.
    expect(bView.you.slots!.every((s) => s.bannedInRound === null)).toBe(true)
    expect(bView.rounds[0]!.ban.A).toBeUndefined()
  })

  it('shows the banner their own ban immediately', () => {
    const state = oneBanPlaced()
    const aView = project(state, 'A')
    // A placed it; hiding it from A would be hiding a fact from the person who authored it.
    expect(aView.rounds[0]!.ban.A).not.toBeUndefined()
    expect(aView.opponent.slots!.some((s) => s.bannedInRound === 0)).toBe(true)
  })

  it('says that a ban was placed even while what it hit is sealed', () => {
    const bView = project(oneBanPlaced(), 'B')
    // Otherwise the wait for the other seat is unexplainable — the same reason
    // `selectionCommitted` exists beside a sealed `selection`.
    expect(bView.rounds[0]!.banCommitted.A).toBe(true)
    expect(bView.rounds[0]!.banCommitted.B).toBe(false)
  })

  it('does not leak through the ban pool either', () => {
    // B is choosing a target on A's board, which A's own ban does not touch. If B's options
    // narrowed after A banned, the pool itself would be carrying the answer.
    const before = driveUntil(commitAll(bo1()), atModule('rounds.0.ban'))
    const after = oneBanPlaced()
    expect(currentAction(after, 'B', 'BAN')!.targets).toEqual(
      currentAction(before, 'B', 'BAN')!.targets,
    )
  })

  it('opens both bans once the second lands', () => {
    let state = oneBanPlaced()
    state = apply(state, 'B', materialize(currentAction(state, 'B', 'BAN')!, 'B'))

    for (const seat of SEATS) {
      const view = project(state, seat)
      expect(view.rounds[0]!.ban.A).not.toBeUndefined()
      expect(view.rounds[0]!.ban.B).not.toBeUndefined()
      // And the effect is legible on the board, which is what a player actually reads.
      expect(view.you.slots!.some((s) => s.bannedInRound === 0)).toBe(true)
      expect(view.opponent.slots!.some((s) => s.bannedInRound === 0)).toBe(true)
    }
  })

  it('never puts a sealed ban in the serialized frame', () => {
    const frame = JSON.stringify(project(oneBanPlaced(), 'B'))
    const round = project(oneBanPlaced(), 'A').rounds[0]!
    const banned = round.ban.A
    expect(banned).not.toBeUndefined()
    // The whole §7 rule: absent from the object, not null and not flagged.
    expect(frame).not.toContain('"bannedInRound":0')
  })
})

describe('the rest of the round', () => {
  it('sends the higher roll first, with nobody holding a privilege', () => {
    const done = playMatch(bo1(), ['A'])
    const round = done.rounds[0]!

    expect(round.roll).not.toBeNull()
    expect(round.playOrder!.first).toBe(round.roll!.winner)
    /*
     * Neither holder is set, and both absences are deliberate. D2's draft privilege exists to
     * distribute an asymmetric ban across three rounds, and there is no asymmetric ban here nor a
     * next round to compensate in. `turnOrderHolder` is the *right to decide* play order — and in
     * this format nobody decides it, so holding it would be holding a right you cannot exercise.
     */
    expect(round.privilegeHolder).toBeNull()
    expect(round.turnOrderHolder).toBeNull()
  })

  it('records that nobody declared it, rather than crediting the roll winner', () => {
    const done = playMatch(bo1(), ['A'])
    // Naming the winner as the declarer would put a decision in the permanent log that no player
    // ever made. The dice decided; `declaredBy: null` says exactly that.
    expect(done.rounds[0]!.playOrder!.declaredBy).toBeNull()
  })

  it('never asks anyone to declare play order', () => {
    // D24's CHOOSE is absent from this mode's program entirely — not present-but-skipped, which
    // would leave a module the round could stall on.
    const ids = bo1().mode.program.map((m) => m.id)
    expect(ids).not.toContain('rounds.0.declareOrder')
    expect(ids).toEqual([
      'draft',
      'rounds.0.ban',
      'rounds.0.select',
      'rounds.0.roll',
      'rounds.0.report',
    ])
  })

  it('leaves the Bo3 declaration exactly where it was', async () => {
    // The new `assigns` value is additive: every existing round still hands out the *right* to
    // declare and still asks for the declaration.
    const { baseMode } = await import('@banpick/engine')
    const done = playMatch(startMatch({ mode: baseMode, draftCount: 4 }), ['A', 'B', 'A'])
    const round = done.rounds[0]!
    expect(round.turnOrderHolder).not.toBeNull()
    expect(round.playOrder!.declaredBy).toBe(round.turnOrderHolder)
  })

  it('still offers D15’s undo on the only round there is', () => {
    /*
     * Worth pinning rather than assuming. D15 lets either seat undo the last result *including on
     * the final round*, and on a Bo1 the final round is the whole match — so this is the case
     * where undo reopens a completed match with nothing behind it. It works because the undo
     * window is a question about the last result, not about how many rounds a mode has.
     */
    const done = playMatch(bo1(), ['A'])
    expect(done.status).toBe('COMPLETE')
    for (const seat of SEATS) {
      const types = legalActions(done, seat).map((a) => a.type)
      expect(types).toContain('UNDO_LAST_RESULT')
      // And nothing that would advance a match that has already ended.
      expect(types.filter((t) => t !== 'UNDO_LAST_RESULT' && t !== 'AMEND_RESULT')).toEqual([])
    }
  })
})
