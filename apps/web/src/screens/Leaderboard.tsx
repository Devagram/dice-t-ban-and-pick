import { useEffect, useState } from 'react'

import type { Character } from '@banpick/types'

import {
  fetchHero,
  fetchHeroes,
  fetchRoster,
  fetchStandings,
  type HeroBoard,
  type HeroHistory,
  type HeroMatchup,
  type HeroStanding,
  type Standing,
} from '../api.js'
import { Portrait } from '../components/Portrait.js'
import { playerId } from '../player.js'
import { StatsBoard } from './Stats.js'

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
  board: 'players' | 'heroes' | 'stats'
  onBack: () => void
}) {
  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Leaderboard</h1>
        <p className="hero__sub">
          {board === 'heroes'
            ? 'Every hero drafted here'
            : board === 'stats'
              ? 'What everybody brings, and who everybody bans'
              : 'Everyone who has played here'}
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
        <a
          className={`boards__tab ${board === 'stats' ? 'boards__tab--on' : ''}`}
          href="/stats"
          aria-current={board === 'stats' ? 'page' : undefined}
        >
          Stats
        </a>
      </nav>

      {board === 'heroes' ? <HeroesBoard /> : board === 'stats' ? <StatsBoard /> : <PlayersBoard />}
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
 * **Some rounds belong to nobody, and fewer than it first looked.** Matches recorded before D45
 * stored which heroes a seat used but not which round each played. Where every round of a match
 * went the same way that is enough — each hero won, or lost, or drew its own round whatever the
 * order — so those are credited. A split is not: one hero won and one lost, and nothing left says
 * which. Those are counted and reported rather than quietly dropped or quietly halved.
 */
function HeroesBoard() {
  const [board, setBoard] = useState<HeroBoard | null>(null)
  const [roster, setRoster] = useState<Map<string, Character>>(new Map())
  const [error, setError] = useState<string | null>(null)
  /*
   * One hero open at a time. A board with six rows expanded is a page you scroll past rather than
   * a table you compare across, and comparing is what a leaderboard is for.
   */
  const [open, setOpen] = useState<string | null>(null)

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
            <HeroRow
              key={hero.characterId}
              hero={hero}
              rank={i + 1}
              roster={roster}
              open={open === hero.characterId}
              onToggle={() =>
                setOpen((current) => (current === hero.characterId ? null : hero.characterId))
              }
            />
          ))}
        </tbody>
      </table>

      {board.unattributedRounds > 0 ? (
        <p className="field__help">
          {board.unattributedRounds} {board.unattributedRounds === 1 ? 'round is' : 'rounds are'}{' '}
          credited to nobody. Older matches did not store which hero played which round: where every
          round of one went the same way that can still be worked out, and where it was split it
          cannot — one hero won and one lost, and nothing left says which.
        </p>
      ) : null}
    </section>
  )
}

function HeroRow({
  hero,
  rank,
  roster,
  open,
  onToggle,
}: {
  hero: HeroStanding
  rank: number
  roster: Map<string, Character>
  open: boolean
  onToggle: () => void
}) {
  const rounds = hero.wins + hero.losses + hero.draws
  const character = roster.get(hero.characterId)
  const name = character?.name ?? pretty(hero.characterId)
  const nameOf = (id: string) => roster.get(id)?.name ?? pretty(id)

  return (
    <>
      <tr
        className={`table__row ${rank === 1 && rounds > 0 ? 'table__row--lead' : ''} ${
          open ? 'table__row--open' : ''
        }`}
      >
        <td className="table__rank">{rank}</td>
        <td className="table__name">
          {/*
           * A button around the face and the name rather than a click handler on the row: a row is
           * not a control, and this one has to be reachable by keyboard and announce that it opens
           * something. The target is still most of the cell.
           */}
          <button
            type="button"
            className="hrow hrow--toggle"
            aria-expanded={open}
            onClick={onToggle}
          >
            {/* Art is optional everywhere (see `art.ts`), and a hero with none still needs a row —
                `Portrait` falls back to initials on its own hue. A hero the roster has forgotten
                gets no tile at all rather than an invented character. */}
            {character ? <Portrait character={character} size="chip" /> : null}
            <span className="hrow__text">
              {/* The marker is a sibling of the name, not inside it: a hero's name is the name,
                  and anything else in that element ends up in every reading of it. */}
              <span className="hrow__title">
                <span className="hrow__name">{name}</span>
                <span className="hrow__more" aria-hidden="true">
                  {open ? '−' : '+'}
                </span>
              </span>
              <span className="hrow__drafted">
                drafted {hero.drafted}
                {/* Drafted and never reached is the other half of what a pick meant — and the one
                    number here that counts every match ever recorded. */}
                {hero.drafted > hero.played ? ` · benched ${hero.drafted - hero.played}` : ''}
              </span>
            </span>
          </button>

          {/*
           * Who this hero beats and who beats it, under it — outside the button, because a list of
           * other heroes' names inside the control that opens *this* one reads as a link to them.
           *
           * The overall rate says how a hero does; this says *against whom*, which is the question
           * anybody arguing about a draft is actually asking. Level matchups appear in neither
           * list — a pairing nobody is winning is not somebody's best or worst. The full list,
           * level records included, is in the panel below.
           */}
          <Ends label="beats" kind="best" matchups={hero.best} nameOf={nameOf} />
          <Ends label="loses to" kind="worst" matchups={hero.worst} nameOf={nameOf} />
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

      {/*
       * Its own row rather than a cell that grows, so the four columns above keep their widths —
       * and deliberately *not* `table__row`, which every reader of this table selects on to count
       * heroes.
       */}
      {open ? (
        <tr className="herodetail">
          <td className="herodetail__cell" colSpan={4}>
            <HeroHistoryPanel characterId={hero.characterId} roster={roster} />
          </td>
        </tr>
      ) : null}
    </>
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
 * **D48 — the games behind the row.**
 *
 * Fetched when the row is opened rather than with the board: forty-four heroes' worth of match
 * lists is a download, not a table. Unmounted when it closes, so a hero corrected in the admin
 * screen and looked at again shows what the record now says.
 */
function HeroHistoryPanel({
  characterId,
  roster,
}: {
  characterId: string
  roster: Map<string, Character>
}) {
  const [history, setHistory] = useState<HeroHistory | null>(null)
  const [error, setError] = useState(false)
  const nameOf = (id: string) => roster.get(id)?.name ?? pretty(id)

  useEffect(() => {
    let live = true
    fetchHero(characterId)
      .then((h) => {
        if (!live) return
        /*
         * A body that is not the shape this renders is a failure, not a slow load. Without the
         * check a malformed response leaves the panel on "Loading…" for good, which is the one
         * state that tells the reader nothing and never resolves.
         */
        if (!h || !Array.isArray(h.appearances)) setError(true)
        else setHistory(h)
      })
      .catch(() => {
        if (live) setError(true)
      })
    return () => {
      live = false
    }
  }, [characterId])

  if (error) return <p className="muted">Could not load that hero’s games.</p>
  if (!history) return <p className="muted">Loading…</p>
  if (history.appearances.length === 0) {
    return (
      <p className="muted">
        No round here can be credited to {nameOf(characterId)} yet — see the note under the table.
      </p>
    )
  }

  return (
    <div className="hpanel">
      {history.matchups.length > 0 ? (
        <section className="hpanel__block">
          <h3 className="hpanel__title">Against</h3>
          {/*
           * Every opponent, best first — the row above shows three a side, and somebody who opened
           * this wants the ones the summary left out. Level records are here too: the row omits
           * them because they are neither a best nor a worst, which is not a reason to hide them
           * from the list they belong in.
           */}
          <ul className="hpanel__ups">
            {history.matchups.map((m) => (
              <li className="hup" key={m.characterId}>
                <span className="hup__name">{nameOf(m.characterId)}</span>
                <span className={`hup__record hup__record--${edgeName(m)}`}>
                  {m.wins}–{m.losses}
                  {m.draws > 0 ? `–${m.draws}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="hpanel__block">
        <h3 className="hpanel__title">
          {history.appearances.length} {history.appearances.length === 1 ? 'round' : 'rounds'}
        </h3>
        <ul className="hpanel__rounds">
          {history.appearances.map((a, i) => (
            <li className={`hgame hgame--${a.outcome.toLowerCase()}`} key={`${a.roomCode}:${i}`}>
              <span className="hgame__when">{when(a.playedAt)}</span>
              <span className="hgame__who">
                {/* Whose hands it was in, and whose it was up against — the row above counts
                    heroes, and a hero is only ever as good as somebody was with it. */}
                <strong>{a.player.name || 'Unknown'}</strong> vs {a.opponent.name || 'Unknown'}
              </span>
              {/* D51 — the mode when the record knows it, and the shape it implies when it does
                  not. A named mode and an inferred `Bo3` are different claims, so the named one
                  wins where there is one. */}
              <span
                className="hgame__mode"
                title={a.modeId ? `mode ${a.modeId}` : 'from the round count'}
              >
                {a.modeId ?? a.format}
                {a.draftCount > 0 ? ` · draft ${a.draftCount}` : ''}
              </span>
              <span className="hgame__round">
                {/* Null when the round came out of a sweep (D47): the result is known and which
                    round it was is not, and a plausible R1 would be the one invented thing here. */}
                {a.round === null ? 'round unknown' : a.round >= 3 ? 'OT' : `R${a.round + 1}`}
              </span>
              <span className="hgame__vs">
                {a.opponent.hero ? `vs ${nameOf(a.opponent.hero)}` : 'opponent unknown'}
              </span>
              <span className="hgame__outcome">
                {a.outcome === 'WIN' ? 'Won' : a.outcome === 'LOSS' ? 'Lost' : 'Drew'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** Which of the three colours a matchup record wears. Level is its own answer, not a weak win. */
function edgeName(m: HeroMatchup): 'up' | 'down' | 'level' {
  if (m.wins > m.losses) return 'up'
  if (m.wins < m.losses) return 'down'
  return 'level'
}

/** Same shape the history page uses, so a date reads the same wherever it appears. */
function when(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
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
