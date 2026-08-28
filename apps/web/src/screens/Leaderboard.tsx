import { useEffect, useState } from 'react'

import { fetchStandings, type Standing } from '../api.js'
import { playerId } from '../player.js'

/**
 * D29 — the table.
 *
 * A scoreboard among people who share a link, which is the line D29 draws against the tournament
 * apparatus D19 still rejects. Draws are their own column rather than half a win: D21 makes
 * 1½–1½ a real terminal state, and folding it into wins would describe a different game.
 *
 * **Rebuilt as a real table (2026-08-28).** It was a list of rows with two `aria-hidden` header
 * rows above it — `Matches`/`Rounds`, then `W L D` / `W L D` beneath — and the two problems were
 * the same problem. Six identical single-letter columns give the eye nothing to land on, so
 * reading a record meant counting across to work out which `W` you were under; and a screen
 * reader, handed the headers with `aria-hidden`, got a list of eight unlabelled numbers.
 *
 * So: `<table>`, `<th scope="col">`, one header row that names both the group and its key. The
 * numbers are joined into the record they actually are — `7–3–1`, read as a record rather than
 * counted as three columns — and the proportion bar under the matches says who is ahead before
 * anybody reads a digit.
 *
 * **No win percentage.** It is the obvious next thing to add and it would have to answer "is a
 * draw half a win?", which is precisely the question D29 refused to answer by giving draws their
 * own column. The bar shows the share of each without inventing a formula.
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
    <main className="screen">
      <header className="hero">
        <h1 className="title">Leaderboard</h1>
        <p className="hero__sub">Everyone who has played here</p>
        {/* In the header, where every other screen keeps it. This one had it alone at the foot of
            the page, so the way out moved depending on how many people had played. */}
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
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
        <section className="panel panel--table">
          <table className="table">
            <caption className="sr-only">Standings, best record first</caption>
            <thead>
              <tr className="table__row table__row--head">
                <th scope="col" className="table__rank">
                  <span aria-hidden="true">#</span>
                  <span className="sr-only">Rank</span>
                </th>
                <th scope="col" className="table__name">
                  Player
                </th>
                {/* The key sits under the group name rather than in a second header row: one row
                    that says "Matches, W–L–D" beats two that have to be read together. */}
                <th scope="col" className="table__matches">
                  <span className="table__head">Matches</span>
                  <span className="table__key">W–L–D</span>
                </th>
                <th scope="col" className="table__rounds">
                  <span className="table__head">Rounds</span>
                  <span className="table__key">W–L–D</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s, i) => (
                <tr
                  key={s.playerId}
                  className={`table__row ${s.playerId === me ? 'table__row--you' : ''} ${
                    i === 0 ? 'table__row--lead' : ''
                  }`}
                >
                  <td className="table__rank">{i + 1}</td>
                  <td className="table__name">
                    {s.name || 'Unnamed'}
                    {s.playerId === me ? <span className="table__you"> you</span> : null}
                  </td>
                  {/* Matches, then the rounds inside them — a 2–1 win is one match and three
                      rounds, and the two answer different questions about a player. */}
                  <td className="table__matches">
                    <Record wins={s.wins} losses={s.losses} draws={s.draws} />
                    <Share wins={s.wins} losses={s.losses} draws={s.draws} />
                  </td>
                  <td className="table__rounds">
                    <Record wins={s.roundWins} losses={s.roundLosses} draws={s.roundDraws} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}

/**
 * `7–3–1`, rather than three numbers under three letters.
 *
 * A record is read as one thing, and spacing it into columns made the reader do the joining. The
 * numbers keep their own spans — the separators are decoration, and a zero is dimmed rather than
 * hidden so the columns still line up and the digits that mean something are the ones that carry
 * weight.
 */
function Record({ wins, losses, draws }: { wins: number; losses: number; draws: number }) {
  return (
    <span className="table__record">
      {[wins, losses, draws].map((value, i) => (
        <span key={i}>
          {i > 0 ? (
            <span className="table__sep" aria-hidden="true">
              –
            </span>
          ) : null}
          <span className={`table__num ${value === 0 ? 'table__num--nil' : ''}`}>{value}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * The same record as a proportion, so the table can be read without reading it.
 *
 * Decorative by construction — it restates the three numbers immediately above it, which is why
 * it is hidden from the accessibility tree rather than announced twice. Wins lead from the left,
 * because that is the direction the eye already scans a leaderboard in.
 */
function Share({ wins, losses, draws }: { wins: number; losses: number; draws: number }) {
  const played = wins + losses + draws
  if (played === 0) return null
  const width = (n: number) => ({ width: `${(n / played) * 100}%` })

  return (
    <span className="table__share" aria-hidden="true">
      {wins > 0 ? <span className="table__seg table__seg--win" style={width(wins)} /> : null}
      {draws > 0 ? <span className="table__seg table__seg--draw" style={width(draws)} /> : null}
      {losses > 0 ? <span className="table__seg table__seg--loss" style={width(losses)} /> : null}
    </span>
  )
}
