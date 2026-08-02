import { describe, expect, it } from 'vitest'
import { bringBan1Mode, project, reduce } from '@banpick/engine'
import type { EventPayload } from '@banpick/types'

import { apply, currentAction, expectRejected, startMatch, ROSTER_10 } from './helpers.js'
import type { MatchState, Seat } from '@banpick/types'

/** One event through `reduce`, so a rejection can be inspected rather than thrown. */
const send = (state: MatchState, actor: Seat | 'SYSTEM', payload: EventPayload) =>
  reduce(state, { v: 1, seq: state.log.length, tag: 'test', actor, payload })

/**
 * D28 — you may not bring the same meta ban against the same person two sets running.
 *
 * The rule spans matches, but the **engine** does not: it learns the history the same way it
 * learns the roster and the ruleset, by being handed it in an event. `PAIRING_RESOLVED` is
 * written by the DO the moment the second seat fills, which is the first point at which there is
 * a pairing to look up — a room is opened before anyone sits.
 *
 * Everything below is about the engine honouring what it was told. Whether it was told the
 * *right* thing is the DO's job, and is tested in `apps/worker/test/`.
 */

const resolved = (denied: { A?: string[]; B?: string[] }): EventPayload => ({
  type: 'PAIRING_RESOLVED',
  deniedMetaBans: { A: denied.A ?? [], B: denied.B ?? [] },
})

/** A match at the ban phase, with whatever history the DO would have handed it. */
function atBanPhase(denied: { A?: string[]; B?: string[] }, repeatBans: 'ALLOWED' | 'FORBIDDEN') {
  const state = startMatch({
    mode: bringBan1Mode,
    draftCount: 4,
    roster: ROSTER_10,
    constraints: { repeatBans },
  })
  return apply(state, 'SYSTEM', resolved(denied))
}

describe('a repeated ban is not offered', () => {
  it('drops last set’s ban from the pool, and only for the seat that placed it', () => {
    const state = atBanPhase({ A: ['oracle'], B: ['sentinel'] }, 'FORBIDDEN')

    const forA = currentAction(state, 'A', 'COMMIT')!.metaBan!.pool
    const forB = currentAction(state, 'B', 'COMMIT')!.metaBan!.pool

    expect(forA).not.toContain('oracle')
    expect(forB).not.toContain('sentinel')
    // Each seat is barred from its *own* previous ban. A is free to ban what B banned.
    expect(forA).toContain('sentinel')
    expect(forB).toContain('oracle')
  })

  it('rejects it even if a client sends it anyway', () => {
    // §11.4 — the pool is advice to the UI; the reducer is what makes it a rule. A client that
    // ignored the pool, or one running older code, must not get the ban through.
    const state = atBanPhase({ A: ['oracle'] }, 'FORBIDDEN')
    const rejection = expectRejected(
      send(state, 'A', {
        type: 'COMMIT',
        moduleId: 'ban',
        seat: 'A',
        picks: [],
        metaBan: 'oracle',
      }),
    )
    expect(rejection.code).toBe('ILLEGAL_CHARACTER')
  })

  it('leaves the pool alone when the host allows repeats', () => {
    const state = atBanPhase({ A: ['oracle'] }, 'ALLOWED')
    expect(currentAction(state, 'A', 'COMMIT')!.metaBan!.pool).toContain('oracle')
  })

  it('leaves the pool alone when there is no history — a first meeting', () => {
    const state = atBanPhase({}, 'FORBIDDEN')
    const pool = currentAction(state, 'A', 'COMMIT')!.metaBan!.pool
    expect(pool).toContain('oracle')
    expect(pool.length).toBeGreaterThan(0)
  })

  it('touches nothing but the meta ban pool', () => {
    // The denial is about what you may *ban*, not about what you may draft — you can still play
    // the character you banned last time.
    const state = atBanPhase({ A: ['oracle'] }, 'FORBIDDEN')
    const banned = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'anvil',
    })
    const withB = apply(banned, 'B', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'B',
      picks: [],
      metaBan: 'duelist',
    })
    expect(currentAction(withB, 'A', 'COMMIT')!.picks!.poolBySlot[0]).toContain('oracle')
  })
})

describe('you are told what you may not ban, and only about yourself', () => {
  it('shows you your own denial', () => {
    // Without this the character simply vanishes from the pool with no explanation, which reads
    // as a bug rather than as a rule.
    const state = atBanPhase({ A: ['oracle'], B: ['sentinel'] }, 'FORBIDDEN')
    expect(project(state, 'A').you.deniedMetaBans).toEqual(['oracle'])
  })

  it('never shows you theirs', () => {
    // Their denial *is* what they banned last set — something they know and you should not. §7
    // is about hiding what a seat may not see, and this is a new thing a seat may not see.
    const state = atBanPhase({ A: ['oracle'], B: ['sentinel'] }, 'FORBIDDEN')
    const view = project(state, 'A')
    expect('deniedMetaBans' in view.opponent).toBe(false)
    expect(JSON.stringify(view.opponent)).not.toContain('sentinel')
  })

  it('says nothing at all when there is nothing to say', () => {
    // Absent rather than an empty array — the same shape §7 uses for everything else, so a leak
    // is a type error rather than something a reviewer has to notice.
    const state = atBanPhase({}, 'FORBIDDEN')
    expect('deniedMetaBans' in project(state, 'A').you).toBe(false)
  })
})

describe('D29 — who is in each seat is public', () => {
  it('shows both players, because a name is shown to the other side by design', () => {
    // Unlike the ban denial above, this is *not* per-seat: the opponent's name is displayed all
    // match, and their id is what a head-to-head record is looked up by.
    const state = startMatch({
      mode: bringBan1Mode,
      draftCount: 4,
      roster: ROSTER_10,
      players: { A: { id: 'p-a', name: 'Tom' }, B: { id: 'p-b', name: 'Alex' } },
    })

    const view = project(state, 'A')
    expect(view.you.player).toEqual({ id: 'p-a', name: 'Tom' })
    expect(view.opponent.player).toEqual({ id: 'p-b', name: 'Alex' })
  })

  it('omits the field for a seat that never gave one', () => {
    // Absent rather than an empty object — the same shape §7 uses throughout, and an older
    // client sends no identity at all.
    const state = startMatch({ mode: bringBan1Mode, draftCount: 4, roster: ROSTER_10 })
    expect('player' in project(state, 'A').you).toBe(false)
    expect('player' in project(state, 'A').opponent).toBe(false)
  })
})

describe('the history is a fact in the log, not a lookup', () => {
  it('arrives before anything is committed, and is refused afterwards', () => {
    // Late would mean a pool narrowing under a player mid-decision.
    let state = atBanPhase({}, 'FORBIDDEN')
    state = apply(state, 'A', {
      type: 'COMMIT',
      moduleId: 'ban',
      seat: 'A',
      picks: [],
      metaBan: 'anvil',
    })
    expect(send(state, 'SYSTEM', resolved({ A: ['oracle'] })).ok).toBe(false)
  })

  it('is replayable from the log alone, with nothing to look up', () => {
    // The property the whole design turns on. If history ever reached the engine by any route
    // other than an event, this is what would notice.
    const state = atBanPhase({ A: ['oracle'], B: ['sentinel'] }, 'FORBIDDEN')
    let replayed: MatchState | null = null
    for (const event of state.log) {
      const result = reduce(replayed, event)
      expect(result.ok, `replaying ${event.tag} failed`).toBe(true)
      if (result.ok) replayed = result.state
    }
    expect(replayed!.deniedMetaBans).toEqual({ A: ['oracle'], B: ['sentinel'] })
  })
})
