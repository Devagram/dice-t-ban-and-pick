import { useEffect, useState } from 'react'

import type { Character } from '@banpick/types'

import {
  fetchRoster,
  fetchStats,
  type HeroCount,
  type PlayerStats,
  type StatsPage,
} from '../api.js'
import { Portrait } from '../components/Portrait.js'

/**
 * **D50 — the fun ones.**
 *
 * The leaderboard answers who is winning and the hero board answers what is good. This answers
 * what a group actually argues about: what everybody brings, who everybody bans, and — the one
 * nobody can look up any other way — what *you* keep getting banned for.
 *
 * Every figure is a count over the stored matches, derived on every read like every other total
 * here, so an edited or deleted match stops counting rather than leaving a stale one behind.
 *
 * **The sample is on the page, at the top, before any of it.** These are the numbers most likely
 * to be quoted at somebody across a table, and "most hated" over eleven matches is a fact about one
 * evening. Printing the sample beside the superlative is the difference between a fun statistic
 * and a wrong one.
 */
export function StatsBoard() {
  const [stats, setStats] = useState<StatsPage | null>(null)
  const [roster, setRoster] = useState<Map<string, Character>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [who, setWho] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([fetchStats(), fetchRoster()])
      .then(([s, r]) => {
        if (!live) return
        setStats(s)
        setRoster(new Map((r.characters ?? []).map((c) => [c.id, c])))
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
  if (stats === null) return <p className="muted">Loading…</p>
  if (stats.matches === 0) {
    return (
      <section className="panel">
        <p className="muted">Nothing yet. Play a match and the arguing can begin.</p>
      </section>
    )
  }

  const player = stats.players.find((p) => p.playerId === who)

  return (
    <>
      <section className="panel">
        <p className="field__help">
          Counted over {stats.matches} recorded {stats.matches === 1 ? 'match' : 'matches'}. Small
          numbers make loud superlatives — at a dozen games, “most hated” is a fact about one
          evening.
        </p>

        <div className="stats">
          <StatCard
            title="Most picked"
            blurb="Brought to the table more than anybody else"
            counts={stats.picked}
            unit="drafts"
            roster={roster}
          />
          <StatCard
            title="Most hated"
            blurb="Named in the meta ban — taken off you before a card was drawn"
            counts={stats.banned}
            unit="bans"
            roster={roster}
          />
          <StatCard
            title="Most played"
            blurb="Actually reached the table, rather than sat in the draft"
            counts={stats.played}
            unit="rounds"
            roster={roster}
          />
          <StatCard
            title="Most benched"
            blurb="Drafted, and then never played — the insurance nobody claimed"
            counts={stats.benched}
            unit="times"
            roster={roster}
          />
          {/*
           * D4 scopes a ban to the opponent rather than removing the character from the match, so
           * banning one and then drafting it yourself is legal and pointed. `bring-ban1`'s own
           * notes call it the steal; it is the most personal thing anybody does here.
           */}
          <StatCard
            title="Most stolen"
            blurb="Banned off somebody — and then drafted by the person who banned it"
            counts={stats.stolen}
            unit="steals"
            roster={roster}
          />
          <StatCard
            title="Most mirrored"
            blurb="Both players brought it to the same match"
            counts={stats.mirrored}
            unit="matches"
            roster={roster}
          />
          {/*
           * D51 — the round ban, kept apart from the meta ban above. One is a character taken off
           * you before you drafted; the other is a card taken away for a single round, three times
           * a match. A figure that added them together would answer neither question.
           */}
          <StatCard
            title="Most denied"
            blurb="Banned out of a single round, once the draft was on the table"
            counts={stats.denied}
            unit="rounds"
            roster={roster}
          />
          <StatCard
            title="Most counter-picked"
            blurb="Chosen second in a round, knowing what it was up against"
            counts={stats.counterPicked}
            unit="rounds"
            roster={roster}
          />
          <StatCard
            title="Most answered"
            blurb="Put down first, and picked against — the one people respond to"
            counts={stats.answered}
            unit="rounds"
            roster={roster}
          />
        </div>

        {/*
         * The two counter-pick cards read from something the record only started keeping recently,
         * so an empty pair means "not yet" rather than "never happened". Saying which is the whole
         * difference between a page that is filling up and one that looks broken.
         */}
        {stats.sequentialRounds === 0 ? (
          <p className="field__help">
            Nothing has been counter-picked yet — the record only started keeping which seat chose
            first recently, and a blind round has no order to keep. These two fill up from the next
            match on.
          </p>
        ) : (
          <p className="field__help">
            Counter-picks counted over {stats.sequentialRounds} rounds whose selection order the
            record knows. A blind round has no order and is not one of them.
          </p>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">By player</h2>
        <label className="field">
          <span className="field__label">Whose habits</span>
          <select
            className="field__input"
            aria-label="Whose habits"
            value={who}
            onChange={(e) => setWho(e.target.value)}
          >
            <option value="">Choose…</option>
            {stats.players.map((p) => (
              <option key={p.playerId} value={p.playerId}>
                {p.name || 'Unnamed'} ({p.matches})
              </option>
            ))}
          </select>
        </label>

        {player ? <PlayerCards player={player} roster={roster} /> : null}
      </section>
    </>
  )
}

function PlayerCards({ player, roster }: { player: PlayerStats; roster: Map<string, Character> }) {
  return (
    <div className="stats">
      <StatCard
        title={`${player.name || 'They'} bring`}
        blurb="What they draft, given the choice"
        counts={player.picked}
        unit="drafts"
        roster={roster}
      />
      <StatCard
        title="They ban"
        blurb="Who they take off the other side before the draft"
        counts={player.banned}
        unit="bans"
        roster={roster}
      />
      {/*
       * The one nobody can look up any other way: what you are *known* for. It is the opponent's
       * ban rather than your own, which is why it is a fact about you rather than about them.
       */}
      <StatCard
        title="Banned against them"
        blurb="What the table thinks they are dangerous with"
        counts={player.bannedAgainst}
        unit="bans"
        roster={roster}
      />
    </div>
  )
}

/**
 * One superlative, and the two or three behind it.
 *
 * The runners-up are the point rather than padding: "most hated" with nothing under it is an
 * assertion, and the same list with a 9, an 8 and a 7 in it is an argument — it shows whether the
 * top of the list is a landslide or a coin flip.
 */
function StatCard({
  title,
  blurb,
  counts,
  unit,
  roster,
}: {
  title: string
  blurb: string
  counts: HeroCount[]
  unit: string
  roster: Map<string, Character>
}) {
  /*
   * `?? []` for the window where a new page is served by an older worker: a card whose figure has
   * not been deployed yet should read "nobody yet", not take the page down with it.
   */
  const listed = counts ?? []
  const leader = listed[0]
  const character = leader ? roster.get(leader.characterId) : undefined

  return (
    <section className="statcard">
      <h3 className="statcard__title">{title}</h3>
      {leader === undefined ? (
        // A card with nothing in it says so rather than disappearing: which of these has never
        // happened here is itself worth knowing.
        <p className="statcard__none">Nobody yet.</p>
      ) : (
        <>
          <div className="statcard__leader">
            {character ? <Portrait character={character} size="chip" /> : null}
            <span className="statcard__name">{nameOf(roster, leader.characterId)}</span>
            <span className="statcard__count">
              {leader.count} {unit}
            </span>
          </div>
          {listed.length > 1 ? (
            <ul className="statcard__rest">
              {listed.slice(1).map((c) => (
                <li className="statcard__runner" key={c.characterId}>
                  <span>{nameOf(roster, c.characterId)}</span>
                  <span className="statcard__count">{c.count}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <p className="statcard__blurb">{blurb}</p>
    </section>
  )
}

/** A character id the roster no longer names still has to read as a name. */
function nameOf(roster: Map<string, Character>, id: string): string {
  return (
    roster.get(id)?.name ??
    id
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  )
}
