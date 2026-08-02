import { useEffect, useState } from 'react'

import { fetchStandings, type Standing } from '../api.js'
import { playerId } from '../player.js'

/**
 * D29 — the table.
 *
 * A scoreboard among people who share a link, which is the line D29 draws against the tournament
 * apparatus D19 still rejects. Draws are their own column rather than half a win: D21 makes
 * 1½–1½ a real terminal state, and folding it into wins would describe a different game.
 */
export function Leaderboard({ onBack }: { onBack: () => void }) {
  const [standings, setStandings] = useState<Standing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const me = playerId()

  useEffect(() => {
    fetchStandings()
      .then((r) => setStandings(r.standings))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  return (
    <main className="screen screen--wide">
      <header className="hero">
        <h1 className="title">Leaderboard</h1>
        <p className="hero__sub">Everyone who has played here</p>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : standings === null ? (
        <p className="muted">Loading…</p>
      ) : standings.length === 0 ? (
        <section className="panel">
          <p className="muted">
            Nothing yet. Play a match with both players named and it will show up here.
          </p>
        </section>
      ) : (
        <section className="panel">
          <ol className="table" aria-label="Standings">
            <li className="table__row table__row--head" aria-hidden="true">
              <span className="table__rank" />
              <span className="table__name">Player</span>
              <span className="table__num">W</span>
              <span className="table__num">L</span>
              <span className="table__num">D</span>
            </li>
            {standings.map((s, i) => (
              <li
                key={s.playerId}
                className={`table__row ${s.playerId === me ? 'table__row--you' : ''}`}
              >
                <span className="table__rank">{i + 1}</span>
                <span className="table__name">
                  {s.name || 'Unnamed'}
                  {s.playerId === me ? <span className="table__you"> you</span> : null}
                </span>
                <span className="table__num">{s.wins}</span>
                <span className="table__num">{s.losses}</span>
                <span className="table__num">{s.draws}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <button type="button" className="btn" onClick={onBack}>
        Back
      </button>
    </main>
  )
}
