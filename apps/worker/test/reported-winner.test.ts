import { describe, expect, it } from 'vitest'

import { materialize, seatedMatch } from './client.js'

/**
 * "I click 'I won' and it records that they won."
 *
 * The whole chain, both directions, through the real server: the outcome a seat reports is the
 * result both seats read back, whichever seat did the reporting. Each leg is asserted separately
 * because an inversion anywhere — client payload, engine apply, per-seat projection — lands here,
 * and a single end-to-end assertion would not say which.
 */
describe('the reported winner survives the round trip', () => {
  for (const winner of ['A', 'B'] as const) {
    for (const reporter of ['A', 'B'] as const) {
      it(`seat ${reporter} reporting a win for ${winner} reads as a win for ${winner}`, async () => {
        const { a, b } = await seatedMatch({ modeId: 'base', draftCount: 4 })
        const clients = { A: a, B: b }

        for (let i = 0; i < 200; i++) {
          if (a.actions().some((x) => x.type === 'REPORT_RESULT')) break
          const actor = [a, b].find((c) => c.isAwaited)
          if (!actor) throw new Error('stalled before any round could be reported')
          const action = actor
            .actions()
            .find((x) => x.type !== 'UNDO_LAST_RESULT' && x.type !== 'AMEND_RESULT')!
          await actor.act(materialize(action, actor.seat, 'A'))
        }

        const client = clients[reporter]
        const report = client.actions().find((x) => x.type === 'REPORT_RESULT')
        if (!report || report.type !== 'REPORT_RESULT') throw new Error('no report step')

        await client.act({
          type: 'REPORT_RESULT',
          moduleId: report.moduleId,
          roundIndex: report.roundIndex,
          reportedBy: reporter,
          outcome: winner,
        })

        const loser = winner === 'A' ? 'B' : 'A'
        const round = report.roundIndex

        // The stored result, read from each seat's own projection.
        expect(a.view.rounds[round]?.result).toBe(winner)
        expect(b.view.rounds[round]?.result).toBe(winner)

        // What each seat's round strip renders: `result === view.seat ? 'You won' : 'They won'`.
        expect(clients[winner].view.rounds[round]?.result === clients[winner].seat).toBe(true)
        expect(clients[loser].view.rounds[round]?.result === clients[loser].seat).toBe(false)

        // And the point went to the winner, not the reporter.
        expect(clients[winner].view.you.score).toBe(1)
        expect(clients[loser].view.you.score).toBe(0)
      })
    }
  }
})
