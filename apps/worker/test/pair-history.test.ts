/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { pairKey, type PairHistory } from '../src/PairHistoryDO.js'

/**
 * D28's memory, on its own.
 *
 * One object per pairing holding one fact: the last meta ban each of those two brought against
 * the other. Tested here in isolation because it is the only state in the app that outlives a
 * match, and the boundary of what it remembers is the decision — not an implementation detail.
 */

const historyFor = (a: string, b: string) =>
  env.PAIR_HISTORY.get(env.PAIR_HISTORY.idFromName(pairKey(a, b)))

const recent = async (a: string, b: string): Promise<PairHistory> => {
  const response = await historyFor(a, b).fetch('https://do/recent')
  return (await response.json()) as PairHistory
}

const record = async (a: string, b: string, bans: Record<string, string>): Promise<Response> =>
  historyFor(a, b).fetch('https://do/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bans }),
  })

describe('the pairing is the same object whoever hosts', () => {
  it('sorts the two ids, so the order they are given in does not matter', () => {
    expect(pairKey('tom', 'alex')).toBe(pairKey('alex', 'tom'))
  })

  it('reaches the same stored history from either direction', async () => {
    await record('tom', 'alex', { tom: 'thor' })
    // Without the sort, "alex vs tom" would be a second history remembering half the story.
    expect((await recent('alex', 'tom')).lastBanBy['tom']).toBe('thor')
  })

  it('keeps a different pairing entirely separate', async () => {
    await record('tom', 'alex', { tom: 'thor' })
    await record('tom', 'sam', { tom: 'loki' })

    expect((await recent('tom', 'alex')).lastBanBy['tom']).toBe('thor')
    expect((await recent('tom', 'sam')).lastBanBy['tom']).toBe('loki')
  })
})

describe('it remembers one set, not a career', () => {
  it('is empty for two people who have never played', async () => {
    expect(await recent('nobody-1', 'nobody-2')).toEqual({ lastBanBy: {} })
  })

  it('overwrites rather than accumulating, so a third set may repeat the first', async () => {
    // The rule is "not two sets running". Keeping a list would make it quietly stricter every
    // time anyone played, which is a different rule that nobody agreed to.
    await record('p1', 'p2', { p1: 'thor' })
    await record('p1', 'p2', { p1: 'storm' })

    const history = await recent('p1', 'p2')
    expect(history.lastBanBy['p1']).toBe('storm')
    expect(JSON.stringify(history)).not.toContain('thor')
  })

  it('records both players from one call', async () => {
    await record('p3', 'p4', { p3: 'thor', p4: 'storm' })
    const history = await recent('p3', 'p4')
    expect(history.lastBanBy).toEqual({ p3: 'thor', p4: 'storm' })
  })

  it('stores nothing but the ban — no names, results, or counts', async () => {
    // The line D19 draws. If this object ever learns who won, that is a new decision, not a
    // refactor.
    await record('p5', 'p6', { p5: 'thor' })
    const history = await recent('p5', 'p6')
    expect(Object.keys(history)).toEqual(['lastBanBy'])
  })
})

describe('it refuses nonsense rather than storing it', () => {
  it('400s a body that will not parse', async () => {
    const response = await historyFor('p7', 'p8').fetch('https://do/record', {
      method: 'POST',
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })

  it('400s a body with no bans object', async () => {
    const response = await historyFor('p7', 'p8').fetch('https://do/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    })
    expect(response.status).toBe(400)
  })

  it('skips entries that are not two strings, and keeps the rest', async () => {
    await record('p9', 'p10', { p9: 'thor', bad: '', '': 'storm' } as Record<string, string>)
    expect((await recent('p9', 'p10')).lastBanBy).toEqual({ p9: 'thor' })
  })
})
