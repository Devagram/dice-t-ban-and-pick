import { describe, expect, it } from 'vitest'
import { baseMode, bringBan1Mode, legalActions, reduce, settle, systemStep } from '@banpick/engine'
import { SEATS, type EventPayload, type MatchState, type Seat } from '@banpick/types'

import { expectOk, materialize, startMatch, ROSTER_75 } from './helpers.js'

/**
 * Phase 1 gate — **legality soundness.**
 *
 * "For every reachable state in a fuzzed corpus, every action in `legalActions()` is accepted
 * by `reduce`, and a sample of actions outside it is rejected."
 *
 * This is the gate that makes §11 non-negotiable 4 safe to rely on. The client renders
 * `legalActions()` and nothing else, so if the two ever disagree, the client either offers
 * something that will bounce or hides something that would have worked — and it has no way to
 * find out which, because it does not have the engine (D18).
 *
 * `legalActions` returns an *option space*, not concrete submissions (drafting 4 from 75 is
 * over a million combinations), so `materialize` closes the loop between offered and accepted.
 */

/** Walks a match, taking a seeded pseudo-random legal action at each step. */
function fuzzMatch(seedIndex: number, mode = baseMode, draftCount: 3 | 4 = 4): MatchState[] {
  const visited: MatchState[] = []
  let state = startMatch({ mode, draftCount, seed: `fuzz-${seedIndex}` })
  let step = 0

  while (state.status === 'IN_PROGRESS' && step < 60) {
    visited.push(state)

    const actors = SEATS.filter((s) =>
      legalActions(state, s).some(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      ),
    )
    if (actors.length === 0) {
      const sys = systemStep(state)
      if (!sys) break
      state = settle(expectOk(reduce(state, sys)))
      continue
    }

    const seat = actors[(seedIndex + step) % actors.length]!
    const options = legalActions(state, seat).filter(
      (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
    )
    const action = options[(seedIndex * 7 + step * 3) % options.length]!

    const result = reduce(state, {
      v: 1,
      seq: state.log.length,
      tag: 'fuzz',
      actor: seat,
      payload: materialize(action, seat, seedIndex + step),
    })

    // The gate itself: everything `legalActions` offered, `reduce` accepts.
    expect(
      result.ok,
      `legalActions offered ${action.type} to seat ${seat}, but reduce rejected it` +
        (result.ok ? '' : `: ${result.code} — ${result.detail}`),
    ).toBe(true)

    state = settle(expectOk(result))
    step++
  }

  visited.push(state)
  return visited
}

describe('legality soundness — offered implies accepted', () => {
  for (const [label, mode, draftCount] of [
    ['base @ 4', baseMode, 4],
    ['base @ 3', baseMode, 3],
    ['bring-ban1 @ 4', bringBan1Mode, 4],
    ['bring-ban1 @ 3', bringBan1Mode, 3],
  ] as const) {
    it(`holds across a fuzzed corpus of ${label}`, () => {
      let states = 0
      for (let seed = 0; seed < 12; seed++) {
        const visited = fuzzMatch(seed, mode, draftCount)
        states += visited.length
        expect(visited.at(-1)!.status).toBe('COMPLETE')
      }
      expect(states).toBeGreaterThan(100)
    })
  }

  it('holds at the ~75-character target scale', () => {
    let state = startMatch({ mode: bringBan1Mode, draftCount: 4, roster: ROSTER_75 })
    let step = 0
    while (state.status === 'IN_PROGRESS' && step++ < 60) {
      const seat = SEATS.find((s) =>
        legalActions(state, s).some(
          (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
        ),
      )
      if (!seat) {
        const sys = systemStep(state)
        if (!sys) break
        state = settle(expectOk(reduce(state, sys)))
        continue
      }
      const action = legalActions(state, seat).find(
        (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
      )!
      const result = reduce(state, {
        v: 1,
        seq: state.log.length,
        tag: 'fuzz75',
        actor: seat,
        payload: materialize(action, seat, step),
      })
      expect(result.ok, `rejected ${action.type}: ${result.ok ? '' : result.code}`).toBe(true)
      state = settle(expectOk(result))
    }
    expect(state.status).toBe('COMPLETE')
  })
})

describe('legality soundness — not offered implies rejected', () => {
  it('rejects an action from the seat that is not being asked', () => {
    // Sampled from every reachable state, not a hand-picked one: whenever exactly one seat is
    // being asked, the other seat submitting the same shape must bounce.
    let checked = 0

    for (let seed = 0; seed < 6; seed++) {
      for (const state of fuzzMatch(seed)) {
        if (state.status !== 'IN_PROGRESS') continue
        const asked = SEATS.filter((s) =>
          legalActions(state, s).some(
            (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
          ),
        )
        if (asked.length !== 1) continue

        const active = asked[0]!
        const idle: Seat = active === 'A' ? 'B' : 'A'
        const action = legalActions(state, active).find(
          (a) => a.type !== 'UNDO_LAST_RESULT' && a.type !== 'AMEND_RESULT',
        )!

        // Same action, wrong seat. `materialize` builds it as if the idle seat were acting.
        const forged = materialize(action, idle, 0) as EventPayload
        const result = reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'forged',
          actor: idle,
          payload: forged,
        })
        expect(result.ok, `seat ${idle} got away with ${action.type}`).toBe(false)
        checked++
      }
    }

    expect(checked, 'the corpus should contain single-actor states to probe').toBeGreaterThan(20)
  })

  it('rejects a character outside the pool at every draft state', () => {
    for (let seed = 0; seed < 6; seed++) {
      for (const state of fuzzMatch(seed, bringBan1Mode)) {
        const commit = SEATS.map((s) => ({
          seat: s,
          action: legalActions(state, s).find((a) => a.type === 'COMMIT'),
        })).find((c) => c.action)
        if (!commit?.action || commit.action.type !== 'COMMIT') continue
        // The ban phase offers no picks, so there is no pick to forge — this assertion is about
        // the draft, and skipping keeps it from silently passing on the wrong module.
        if (!commit.action.picks) continue

        const picks = commit.action.picks.poolBySlot.map((pool, i) => pool[i]!)
        picks[0] = 'definitely-not-a-character'

        const result = reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'forged',
          actor: commit.seat,
          payload: {
            type: 'COMMIT',
            moduleId: commit.action.moduleId,
            seat: commit.seat,
            picks,
            metaBan: commit.action.metaBan?.pool[0] ?? null,
          },
        })
        expect(result.ok).toBe(false)
      }
    }
  })

  it('rejects a ban on an already consumed slot', () => {
    // `legalRoundBan` filters on UNCONSUMED, so a spent slot is never offered. Submitting one
    // anyway must bounce rather than quietly re-banning a slot that is out of the match.
    for (let seed = 0; seed < 8; seed++) {
      for (const state of fuzzMatch(seed)) {
        const seat = SEATS.find((s) => legalActions(state, s).some((a) => a.type === 'BAN'))
        if (!seat) continue
        const action = legalActions(state, seat).find((a) => a.type === 'BAN')!
        if (action.type !== 'BAN') continue

        const opponent: Seat = seat === 'A' ? 'B' : 'A'
        const consumed = state.seats[opponent].slots.value.find((s) => s.consumed)
        if (!consumed) continue

        const result = reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'forged',
          actor: seat,
          payload: {
            type: 'BAN',
            moduleId: action.moduleId,
            roundIndex: action.roundIndex,
            seat,
            tier: 'ROUND',
            target: { seat: opponent, slotIndex: consumed.index },
          },
        })
        expect(result.ok).toBe(false)
      }
    }
  })

  it('rejects a round ban aimed at the banner’s own slot (D3)', () => {
    for (let seed = 0; seed < 4; seed++) {
      for (const state of fuzzMatch(seed)) {
        const seat = SEATS.find((s) => legalActions(state, s).some((a) => a.type === 'BAN'))
        if (!seat) continue
        const action = legalActions(state, seat).find((a) => a.type === 'BAN')!
        if (action.type !== 'BAN') continue

        const own = state.seats[seat].slots.value.find((s) => !s.consumed)!
        const result = reduce(state, {
          v: 1,
          seq: state.log.length,
          tag: 'forged',
          actor: seat,
          payload: {
            type: 'BAN',
            moduleId: action.moduleId,
            roundIndex: action.roundIndex,
            seat,
            tier: 'ROUND',
            target: { seat, slotIndex: own.index },
          },
        })
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe('ILLEGAL_TARGET')
      }
    }
  })
})
