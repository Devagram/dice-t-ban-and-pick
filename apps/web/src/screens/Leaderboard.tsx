import { useEffect, useState } from 'react'

import type { Character } from '@banpick/types'

import {
  fetchHeroes,
  fetchRoster,
  fetchStandings,
  type HeroBoard,
  type HeroMatchup,
  type HeroStanding,
  type Standing,
} from '../api.js'
import { Portrait } from '../components/Portrait.js'
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
 * **No win percentage on the player board.** It is the obvious next thing to add and it would
 * have to answer "is a draw half a win?", which is precisely the question D29 refused to answer by
 * giving draws their own column. The bar shows the share of each without inventing a formula. The
 * hero board *does* carry a rate, and the difference is not an inconsistency: it is the share of
 * rounds won, shown beside the draws rather than having absorbed them.
 *
 * **D45 puts the heroes on the same screen.** "Who is winning" is one question at two grains, and
 * a second page for the second grain would be a second place to look for it. Two boards, one
 * table vocabulary, a URL each.
 */
export function Leaderboard({
  board,
  onBack,
}: {
  board: 'players' | 'heroes'
  onBack: () => void
}) {
  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Leaderboard</h1>
        <p className="hero__sub">
          {board === 'heroes' ? 'Every hero drafted here' : 'Everyone who has played here'}
        </p>
        {/* In the header, where every other screen keeps it. This one had it alone at the foot of
            the page, so the way out moved depending on how many people had played. */}
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      {/*
       * Real links, like the front door's menu and for the same reasons: each board is a URL that
       * works on its own, so it survives a bookmark, a middle click, and being pasted to whoever
       * you are arguing with about whether Krampus is any good.
       */}
      <nav className="boards" aria-label="Leaderboards">
        <a
          className={`boards__tab ${board === 'players' ? 'boards__tab--on' : ''}`}
          href="/leaderboard"
          aria-current={board === 'players' ? 'page' : undefined}
        >
          Players
        </a>
        <a
          className={`boards__tab ${board === 'heroes' ? 'boards__tab--on' : ''}`}
          href="/heroes"
          aria-current={board === 'heroes' ? 'page' : undefined}
        >
          Heroes
        </a>
      </nav>

      {board === 'heroes' ? <HeroesBoard /> : <PlayersBoard />}
    </main>
  )
}

function PlayersBoard() {
  const [standings, setStandings] = useState<Standing[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const me = playerId()

  useEffect(() => {
    fetchStandings()
      .then((r) => setStandings(r.standings))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    )
  }
  if (standings === null) return <p className="muted">Loading…</p>
  if (standings.length === 0) {
    return (
      <section className="panel">
        <p className="muted">
          Nothing yet. Play a match with both players named and it will show up here.
        </p>
      </section>
    )
  }

  return (
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
            <th scope="col" className="table__primary">
              <span className="table__head">Matches</span>
              <span className="table__key">W–L–D</span>
            </th>
            <th scope="col" className="table__secondary">
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
              <td className="table__primary">
                <Record wins={s.wins} losses={s.losses} draws={s.draws} />
                <Share wins={s.wins} losses={s.losses} draws={s.draws} />
              </td>
              <td className="table__secondary">
                <Record wins={s.roundWins} losses={s.roundLosses} draws={s.roundDraws} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/**
 * **D45 — the same rounds, counted by who was on the table rather than who owned the seat.**
 *
 * A round is one hero against one hero, so a round is where a hero's record lives. Two things
 * this screen has to be straight about, because both are easy to fudge into something prettier:
 *
 * **The rate ranks it, whatever the sample.** There was a minimum-rounds gate; the owner's call
 * was that a rate is a rate, and the record sits on the row beside it — a one-round 100% reads as
 * exactly that to anybody looking at the `1–0–0` next to it.
 *
 * **Some rounds belong to nobody.** Matches recorded before D45 stored which heroes a seat used
 * but not which round each one played, so their outcomes cannot be credited. They are counted and
 * reported rather than quietly dropped: a board missing half its history should say which half.
 */
function HeroesBoard() {
  const [board, setBoard] = useState<HeroBoard | null>(null)
  const [roster, setRoster] = useState<Map<string, Character>>(new Map())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([fetchHeroes(), fetchRoster()])
      .then(([heroes, r]) => {
        if (!live) return
        setBoard(heroes)
        setRoster(new Map(r.characters.map((c) => [c.id, c])))
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [])

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    )
  }
  if (board === null) return <p className="muted">Loading…</p>
  if (board.heroes.length === 0) {
    return (
      <section className="panel">
        <p className="muted">Nothing yet. Draft a hero in a match and it will show up here.</p>
      </section>
    )
  }

  return (
    <section className="panel panel--table">
      <p className="field__help">
        Ranked on the share of rounds won, then on how much a hero has been played. Under each is
        who it beats and who beats it — an opponent it is level with is neither.
      </p>

      <table className="table">
        <caption className="sr-only">Heroes, best record first</caption>
        <thead>
          <tr className="table__row table__row--head">
            <th scope="col" className="table__rank">
              <span aria-hidden="true">#</span>
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className="table__name">
              Hero
            </th>
            <th scope="col" className="table__primary">
              <span className="table__head">Rounds</span>
              <span className="table__key">W–L–D</span>
            </th>
            <th scope="col" className="table__secondary">
              <span className="table__head">Won</span>
              <span className="table__key">of those</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {board.heroes.map((hero, i) => (
            <HeroRow key={hero.characterId} hero={hero} rank={i + 1} roster={roster} />
          ))}
        </tbody>
      </table>

      {board.unattributedRounds > 0 ? (
        <p className="field__help">
          {board.unattributedRounds} earlier{' '}
          {board.unattributedRounds === 1 ? 'round is' : 'rounds are'} credited to nobody. Matches
          recorded before this board existed kept which heroes a player brought, but not which of
          them played each round — so they count towards drafted and played, and towards no record.
        </p>
      ) : null}
    </section>
  )
}

function HeroRow({
  hero,
  rank,
  roster,
}: {
  hero: HeroStanding
  rank: number
  roster: Map<string, Character>
}) {
  const rounds = hero.wins + hero.losses + hero.draws
  const character = roster.get(hero.characterId)
  const name = character?.name ?? pretty(hero.characterId)
  const nameOf = (id: string) => roster.get(id)?.name ?? pretty(id)

  return (
    <tr className={`table__row ${rank === 1 && rounds > 0 ? 'table__row--lead' : ''}`}>
      <td className="table__rank">{rank}</td>
      <td className="table__name">
        <span className="hrow">
          {/* Art is optional everywhere (see `art.ts`), and a hero with none still needs a row —
              `Portrait` falls back to initials on its own hue. A hero the roster has forgotten
              gets no tile at all rather than an invented character. */}
          {character ? <Portrait character={character} size="chip" /> : null}
          <span className="hrow__text">
            <span className="hrow__name">{name}</span>
            <span className="hrow__drafted">
              drafted {hero.drafted}
              {/* Drafted and never reached is the other half of what a pick meant — and the one
                  number here that counts every match ever recorded. */}
              {hero.drafted > hero.played ? ` · benched ${hero.drafted - hero.played}` : ''}
            </span>
            {/*
             * Who this hero beats and who beats it, under it.
             *
             * The overall rate says how a hero does; this says *against whom*, which is the
             * question anybody arguing about a draft is actually asking. Level matchups appear in
             * neither list — a pairing nobody is winning is not somebody's best or worst.
             */}
            <Ends label="beats" kind="best" matchups={hero.best} nameOf={nameOf} />
            <Ends label="loses to" kind="worst" matchups={hero.worst} nameOf={nameOf} />
          </span>
        </span>
      </td>
      <td className="table__primary">
        <Record wins={hero.wins} losses={hero.losses} draws={hero.draws} />
        <Share wins={hero.wins} losses={hero.losses} draws={hero.draws} />
      </td>
      <td className="table__secondary">
        {rounds === 0 ? (
          <span className="table__rate table__rate--none" title="no rounds credited to this hero">
            —
          </span>
        ) : (
          <span className="table__rate" title={`${hero.wins} of ${rounds} rounds`}>
            {Math.round((hero.wins / rounds) * 100)}%
          </span>
        )}
      </td>
    </tr>
  )
}

/**
 * One end of a hero's matchup ranking — the opponents it is up on, or the ones it is down against.
 *
 * Ordered by the server, furthest ahead (or behind) first, and capped there at three: the point is
 * the two extremes rather than a full pairwise table, which on a roster of forty-four would be
 * most of the page.
 *
 * Renders nothing at all when that end is empty. A "beats: nobody" line would be a row of noise on
 * every hero that has only ever played level or lost.
 */
function Ends({
  label,
  kind,
  matchups,
  nameOf,
}: {
  label: string
  kind: 'best' | 'worst'
  matchups: HeroMatchup[]
  nameOf: (characterId: string) => string
}) {
  if (matchups.length === 0) return null

  return (
    <span className={`ends ends--${kind}`}>
      <span className="ends__label">{label}</span>
      {matchups.map((m) => (
        <span className="ends__chip" key={m.characterId}>
          <span className="ends__name">{nameOf(m.characterId)}</span>
          <span className="ends__record">
            {m.wins}–{m.losses}
            {/* Draws only when there are any: a trailing `–0` on every chip is three characters of
                nothing, and this is the one place on the board where space is tight. */}
            {m.draws > 0 ? `–${m.draws}` : ''}
          </span>
        </span>
      ))}
    </span>
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

/** A character id the roster no longer names. Same treatment the history page gives one. */
function pretty(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
