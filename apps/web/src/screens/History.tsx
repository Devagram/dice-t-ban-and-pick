import { useEffect, useState } from 'react'

import {
  fetchMatches,
  fetchMatchups,
  fetchTournaments,
  type MatchDetail,
  type MatchRecord,
  type Matchup,
  type TournamentSummary,
} from '../api.js'

/**
 * **D34 — every game played, shown rather than summarised.**
 *
 * The leaderboard answers "who is ahead". This answers "what happened": the Bo3 round by round,
 * what each player brought, and what they actually got to play. All of it was already being
 * stored — D29 kept each match's `detail` precisely so §15's open question about whether the meta
 * ban earns its place could be answered from real games — and none of it had anywhere to be read.
 *
 * Public and read-only. It is the same rows the standings are derived from; the only thing here
 * a leaderboard does not already reveal is the drafted rosters, and hiding those would make the
 * page pointless for the question it exists to answer.
 */
export function History({ onBack }: { onBack: () => void }) {
  const [matches, setMatches] = useState<MatchRecord[] | null>(null)
  const [matchups, setMatchups] = useState<Matchup[]>([])
  const [tournaments, setTournaments] = useState<TournamentSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([fetchMatches(), fetchMatchups(), fetchTournaments()])
      .then(([m, mu, t]) => {
        if (!live) return
        setMatches(m)
        setMatchups(mu)
        setTournaments(t)
      })
      .catch(() => {
        if (live) setError('Could not load the history.')
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Game history</h1>
        <p className="hero__sub">Every match, round by round</p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      {/*
       * D37 Phase 8 — tournaments, above the matchups.
       *
       * Served from the registry rather than from any tournament object: those are swept a week
       * after their last activity (D42), and a week later is usually exactly when somebody wants
       * to look up who won.
       */}
      {tournaments.length > 0 ? (
        <section className="panel">
          <h2 className="panel__title">Tournaments</h2>
          <ul className="matchups">
            {tournaments.map((t) => (
              <li key={t.code} className="matchup">
                <a className="matchup__names" href={`/t/${t.code}`}>
                  {t.code}
                </a>
                <span className="matchup__record">
                  {t.champion ? `${t.champion} won` : 'in progress'}
                </span>
                <span className="matchup__played">
                  {t.entrants.length} {t.entrants.length === 1 ? 'entrant' : 'entrants'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {matchups.length > 0 ? (
        <section className="panel">
          <h2 className="panel__title">Matchups</h2>
          <ul className="matchups">
            {matchups.map((m) => (
              <li key={`${m.a.id}|${m.b.id}`} className="matchup">
                <span className="matchup__names">
                  {m.a.name || 'Unknown'} vs {m.b.name || 'Unknown'}
                </span>
                <span className="matchup__record">
                  {m.aWins}–{m.bWins}
                  {m.draws > 0 ? ` (${m.draws}D)` : ''}
                </span>
                <span className="matchup__played">
                  {m.played} {m.played === 1 ? 'match' : 'matches'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Matches</h2>
        {matches === null ? (
          <p className="panel__empty">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="panel__empty">Nothing has been played yet.</p>
        ) : (
          <ul className="history">
            {matches.map((m) => (
              <MatchCard key={m.roomCode} match={m} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export function MatchCard({ match }: { match: MatchRecord }) {
  const detail = match.detail as MatchDetail | null
  const winner =
    match.winnerId === null ? 'Draw' : match.winnerId === match.a.id ? match.a.name : match.b.name

  return (
    <li className="hmatch">
      <div className="hmatch__head">
        <span className="hmatch__players">
          <strong>{match.a.name || 'Unknown'}</strong> vs{' '}
          <strong>{match.b.name || 'Unknown'}</strong>
        </span>
        <span className="hmatch__score">
          {formatScore(match.scoreA)}–{formatScore(match.scoreB)}
        </span>
        <span className="hmatch__winner">{match.winnerId === null ? 'Draw' : `${winner} won`}</span>
        {/* D37 — a bracket match is not a casual one, and the record should say so. */}
        {match.tournamentId ? (
          <a className="hmatch__tournament" href={`/t/${match.tournamentId}`}>
            {match.tournamentId}
          </a>
        ) : null}
        <span className="hmatch__when">{whenever(match.playedAt)}</span>
      </div>

      {detail?.rounds ? (
        <ol className="hrounds">
          {detail.rounds.map((result, i) => (
            <li key={i} className={`hround hround--${result === null ? 'unplayed' : 'played'}`}>
              {/* Index 3 is D30's overtime round, which is not the fourth round of anything. */}
              <span className="hround__index">{i >= 3 ? 'OT' : `R${i + 1}`}</span>
              <span className="hround__who">
                {result === null ? '—' : result === 'TIE' ? 'Tied' : nameOf(match, result)}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {detail?.seats ? (
        <div className="hrosters">
          {(['A', 'B'] as const).map((seat) => (
            <Roster
              key={seat}
              name={seat === 'A' ? match.a.name : match.b.name}
              side={detail.seats[seat]}
            />
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** Exported for the admin dashboard (D35), which shows the same rosters beside the edit fields. */
export function Roster({
  name,
  side,
}: {
  name: string
  side: { drafted: string[]; played: string[]; metaBan: string | null }
}) {
  const played = new Set(side.played)
  return (
    <div className="hroster">
      <span className="hroster__name">{name || 'Unknown'}</span>
      <ul className="hroster__list">
        {side.drafted.map((id) => (
          // Played characters are the story; drafted-but-never-used is the other half of it, and
          // dimming rather than hiding those is what makes a roster legible as a set of choices.
          <li key={id} className={`hchar ${played.has(id) ? 'hchar--played' : 'hchar--bench'}`}>
            {pretty(id)}
          </li>
        ))}
      </ul>
      {side.metaBan ? <span className="hroster__ban">banned {pretty(side.metaBan)}</span> : null}
    </div>
  )
}

/** The winner of one round, by name rather than by seat letter. */
function nameOf(match: MatchRecord, seat: 'A' | 'B'): string {
  const name = seat === 'A' ? match.a.name : match.b.name
  return name || `Seat ${seat}`
}

/** Character ids are kebab-case; nobody wants to read `gunslinger-x` in a table. */
function pretty(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** HALF_POINT scoring (D21) means halves are ordinary, so they are rendered as halves. */
function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

function whenever(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}
