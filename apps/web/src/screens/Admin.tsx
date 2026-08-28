import { useEffect, useState } from 'react'

import type { Character } from '@banpick/types'

import {
  ApiError,
  adminAddMatch,
  adminDeleteMatch,
  adminEditMatch,
  adminFetchPlayers,
  adminMergePlayers,
  fetchMatches,
  fetchRoster,
  type MatchDetail,
  type MatchRecord,
  type PlayerSummary,
} from '../api.js'
import { Roster } from './History.js'

/**
 * **D34 — editing the record.**
 *
 * Behind a shared key, which D33's in-match amendment is not, and the difference is worth being
 * clear about rather than treating this as "the same thing with a password".
 *
 * D33 amends the *event log* and lets the record follow, so the two keep agreeing and either
 * player may do it — §1's trust model covers a mistake between friends. This edits the *record*
 * directly, because a match from last month has no log left to amend: its Durable Object expired
 * and the stored row is all that survives. So an edit here can leave the record saying something
 * the log never said, and it applies to everyone's games rather than your own. That is why it is
 * the one thing in this app with a password on it.
 *
 * **D35 adds the identities underneath.** Until now this screen edited names, and a name is a
 * caption — every total on every other screen keys on the player id behind it. That is invisible
 * until one person has two ids, which `player.ts` guarantees will happen the first time anyone
 * opens the site on a second machine, and no amount of renaming merges them because renaming was
 * never what split them. So the ids are on screen, and there are two ways to fix them: merge two
 * ids that are one person, or reassign a single match that landed on the wrong one.
 */
const KEY_STORAGE = 'banpick.adminKey'

/**
 * There is nothing to *submit* the key to, and that was the bug.
 *
 * The key is not a login — it is a header attached to each edit — so the field had no button, no
 * form, and no answer to the only question anyone asks after pasting it: did that work? Pressing
 * Enter did nothing, and the first feedback of any kind was a failed save some clicks later.
 *
 * So the field checks itself, and this is what it can report. `disabled` is the one worth
 * separating out: the server answering `503 ADMIN_DISABLED` means *this deployment* has no key at
 * all, which no amount of retyping fixes and which `wrangler dev` hits by default — a local run
 * reads `.dev.vars`, not the secret you set on the deployed Worker.
 */
type KeyCheck = 'empty' | 'checking' | 'accepted' | 'refused' | 'unconfigured' | 'unreachable'

/** Long enough that typing a key is one check rather than one per character. */
const KEY_CHECK_DELAY_MS = 300

/** Guarded like `player.ts` does it: private browsing costs persistence, never the screen. */
function storedKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

function rememberKey(value: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, value)
  } catch {
    // The key still works for this session; it just will not survive a reload.
  }
}

export function Admin({ onBack }: { onBack: () => void }) {
  const [key, setKey] = useState(storedKey)
  const [check, setCheck] = useState<KeyCheck>('empty')
  const [matches, setMatches] = useState<MatchRecord[] | null>(null)
  const [players, setPlayers] = useState<PlayerSummary[]>([])
  /*
   * D46 — the character list, so a hero is chosen from a menu rather than typed.
   *
   * Public (§16) and needed with no key: the heroes on a match row should be readable before
   * anyone proves they may edit them, exactly as the player ids on those rows already are.
   * Empty on failure rather than fatal — the rest of the screen still edits scores and names.
   */
  const [roster, setRoster] = useState<Character[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    fetchMatches()
      .then(setMatches)
      .catch(() => setError('Could not load matches.'))
  }
  useEffect(reload, [])

  useEffect(() => {
    let live = true
    fetchRoster()
      .then((r) => {
        // `?? []` for the reason `adminFetchPlayers` has one: this feeds a `.map`, and a screen
        // that throws on an unexpected shape is a worse answer than one with no hero list.
        if (live) setRoster(r.characters ?? [])
      })
      .catch(noop)
    return () => {
      live = false
    }
  }, [])

  /*
   * Fetching the directory doubles as checking the key, which is why the screen can answer "did
   * that work?" without a submit button: it is a real admin request, so it exercises exactly what
   * an edit will.
   *
   * Debounced, because this runs on every keystroke and every prefix of a correct key is a 401 —
   * reporting each one would flash "refused" at someone who is still typing.
   */
  useEffect(() => {
    if (!key) {
      setPlayers([])
      setCheck('empty')
      return
    }
    let live = true
    setCheck('checking')
    const timer = setTimeout(() => {
      adminFetchPlayers(key)
        .then((list) => {
          if (!live) return
          setPlayers(list)
          setCheck('accepted')
        })
        .catch((cause: unknown) => {
          if (!live) return
          setPlayers([])
          setCheck(
            cause instanceof ApiError
              ? cause.status === 503
                ? 'unconfigured'
                : cause.status === 401
                  ? 'refused'
                  : 'unreachable'
              : 'unreachable',
          )
        })
    }, KEY_CHECK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])

  const remember = (value: string) => {
    setKey(value)
    // Kept in this browser only, like the seat token and the player name (§17's trade). Losing
    // the browser loses it, and that is the same deal everything else here makes.
    rememberKey(value)
  }

  const refreshPlayers = () => {
    if (key) adminFetchPlayers(key).then(setPlayers).catch(noop)
  }

  const run = (work: Promise<unknown>, done: string) => {
    setError(null)
    work
      .then(() => {
        setNotice(done)
        reload()
        refreshPlayers()
      })
      .catch((cause: unknown) => {
        setNotice(null)
        /*
         * The server's own words when it has any. A refused merge says *which* matches block it
         * and there is no way to act on "that did not go through" — the generic line is for a
         * failure with nothing to report, which is overwhelmingly a bad key.
         */
        setError(
          cause instanceof ApiError && cause.message
            ? cause.message
            : 'That did not go through. Check the admin key — the server refuses edits without it.',
        )
      })
  }

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Admin</h1>
        <p className="hero__sub">Correct a recorded result</p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      <section className="panel">
        <label className="field">
          <span className="field__label">Admin key</span>
          <input
            className="field__input"
            type="password"
            /* Explicit, because the wrapping label also contains the help paragraph — without
               this the input's accessible name is that whole block of prose. */
            aria-label="Admin key"
            value={key}
            onChange={(e) => remember(e.target.value)}
            placeholder="wrangler secret put ADMIN_KEY"
          />
          <KeyStatus check={check} />
          <p className="field__help">
            There is nothing to submit — the key is sent with each edit, and it is checked against
            the server as you type.
          </p>
        </label>
      </section>

      {notice ? (
        <p className="alert alert--notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <Players
        players={players}
        disabled={key.length === 0}
        onMerge={(merge) =>
          run(
            adminMergePlayers(key, merge).then((result) => {
              setPlayers(result.players)
              return result
            }),
            'Merged.',
          )
        }
      />

      <AddMatch
        players={players}
        roster={roster}
        disabled={key.length === 0 || check !== 'accepted'}
        onAdd={(entry) => run(adminAddMatch(key, entry), 'Match added.')}
      />

      <section className="panel">
        <h2 className="panel__title">Matches</h2>
        {matches === null ? (
          <p className="panel__empty">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="panel__empty">Nothing recorded yet.</p>
        ) : (
          <ul className="adminlist">
            {matches.map((m) => (
              <EditRow
                /*
                 * Keyed by the seats, not just the room code. A row holds its fields in local
                 * state seeded from the record, and a merge rewrites those ids underneath it —
                 * so a row keyed by room code alone would keep offering the id that was merged
                 * away, and the next Save would quietly put the match back where it started.
                 * Including the ids remounts exactly the rows a merge touched.
                 */
                key={`${m.roomCode}:${m.a.id}:${m.b.id}`}
                match={m}
                players={players}
                roster={roster}
                disabled={key.length === 0}
                onSave={(patch) => run(adminEditMatch(key, patch), `Saved ${m.roomCode}.`)}
                onDelete={() => run(adminDeleteMatch(key, m.roomCode), `Deleted ${m.roomCode}.`)}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

/**
 * Whether this page is being served by a local `wrangler dev`.
 *
 * Only used to decide which half of the "no key configured" advice to give, and that is worth
 * the sniff: the two fixes are genuinely different commands, and printing both leaves the reader
 * to work out which deployment they are looking at — which is the exact confusion that produced
 * this function. `wrangler dev` runs local by default and reads `apps/worker/.dev.vars`; it does
 * not see a secret set with `wrangler secret put`, because that uploads to the deployed Worker.
 */
function servedLocally(): boolean {
  try {
    const host = location.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * What the key field found, in the words that tell you what to do next.
 *
 * `unconfigured` is the one that earns its own message. It means the server has no key at all,
 * which retyping cannot fix — reporting it as "wrong key" would send someone to check the one
 * thing that is not the problem.
 */
function KeyStatus({ check }: { check: KeyCheck }) {
  if (check === 'empty' || check === 'checking') return null

  if (check === 'accepted') {
    return (
      <p className="field__status field__status--ok" role="status">
        Key accepted.
      </p>
    )
  }

  return (
    <p className="field__status field__status--bad" role="status">
      {check === 'refused' ? (
        'The server refused that key.'
      ) : check === 'unconfigured' ? (
        servedLocally() ? (
          <>
            This local <code>wrangler dev</code> has no admin key, so every edit is refused whatever
            you type. It does <strong>not</strong> read the secret set with{' '}
            <code>wrangler secret put</code> — that one goes to the deployed Worker. Put{' '}
            <code>ADMIN_KEY=your-key</code> in <code>apps/worker/.dev.vars</code> and restart{' '}
            <code>npm run dev</code>.
          </>
        ) : (
          <>
            This deployment has no admin key set, so every edit is refused whatever you type. Set
            one with{' '}
            <code>npx wrangler secret put ADMIN_KEY --config apps/worker/wrangler.jsonc</code>.
          </>
        )
      ) : (
        'Could not reach the server to check that key.'
      )}
    </p>
  )
}

/**
 * D35 — the directory, and the one control that changes it.
 *
 * Ids are shown in full rather than shortened. A truncated id is unusable for the thing an admin
 * is here to do — telling two of them apart and pasting one somewhere — and these are opaque
 * random strings, so there is no prefix that means anything on its own.
 */
function Players({
  players,
  disabled,
  onMerge,
}: {
  players: PlayerSummary[]
  disabled: boolean
  onMerge: (merge: { fromId: string; intoId: string; name?: string }) => void
}) {
  const [fromId, setFromId] = useState('')
  const [intoId, setIntoId] = useState('')
  const [name, setName] = useState('')
  const [confirming, setConfirming] = useState(false)

  const from = players.find((p) => p.playerId === fromId)
  const into = players.find((p) => p.playerId === intoId)
  const ready = from !== undefined && into !== undefined && fromId !== intoId

  return (
    <section className="panel">
      <h2 className="panel__title">Players</h2>
      {disabled ? (
        <p className="panel__empty">Enter the admin key to list players.</p>
      ) : players.length === 0 ? (
        <p className="panel__empty">Nobody has claimed a name or finished a match yet.</p>
      ) : (
        <>
          <ul className="adminlist">
            {players.map((p) => (
              <li key={p.playerId} className="playerrow">
                <div className="playerrow__head">
                  <span className="playerrow__name">{p.name || 'Unnamed'}</span>
                  <span className="playerrow__record">
                    {p.wins}–{p.losses}
                    {p.draws > 0 ? `–${p.draws}` : ''}
                  </span>
                  <span className="playerrow__played">
                    {p.played} {p.played === 1 ? 'match' : 'matches'}
                  </span>
                </div>
                <code className="playerrow__id">{p.playerId}</code>
                {/* More than one only after a merge, and worth seeing: it is how you tell a
                    consolidated player from one that always had a single browser. */}
                {p.claimedNames.length > 1 ? (
                  <span className="playerrow__aka">also holds {p.claimedNames.join(', ')}</span>
                ) : null}
                {p.played === 0 ? (
                  // The shape a returning player's new browser has before it has played: named,
                  // counted nowhere. Usually the `fromId` of the merge you came here to do.
                  <span className="playerrow__aka">claimed a name, never finished a match</span>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="merge">
            <h3 className="merge__title">Consolidate two ids</h3>
            <p className="field__help">
              A player id belongs to a browser, so the same person on a new machine is a new player.
              This moves every match from one id onto the other and leaves one row on the
              leaderboard.
            </p>

            <label className="field">
              <span className="field__label">Merge this player</span>
              <select
                className="field__input"
                aria-label="Merge this player"
                value={fromId}
                onChange={(e) => {
                  setFromId(e.target.value)
                  setConfirming(false)
                }}
              >
                <option value="">Choose…</option>
                {players.map((p) => (
                  <option key={p.playerId} value={p.playerId}>
                    {p.name || 'Unnamed'} — {p.playerId} ({p.played})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Into this one</span>
              <select
                className="field__input"
                aria-label="Into this one"
                value={intoId}
                onChange={(e) => {
                  setIntoId(e.target.value)
                  setConfirming(false)
                  // The surviving id's name is the sensible default for what the merged player
                  // should be called, and pre-filling it makes the rename opt-out rather than a
                  // step you discover you needed after the fact.
                  setName(players.find((p) => p.playerId === e.target.value)?.name ?? '')
                }}
              >
                <option value="">Choose…</option>
                {players.map((p) => (
                  <option key={p.playerId} value={p.playerId}>
                    {p.name || 'Unnamed'} — {p.playerId} ({p.played})
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Name them</span>
              <input
                className="field__input"
                aria-label="Name them"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="leave empty to keep each match's name"
              />
            </label>

            <div className="adminrow__actions">
              {confirming && ready ? (
                <>
                  <button
                    type="button"
                    className="btn btn--danger btn--tiny"
                    onClick={() => {
                      onMerge({ fromId, intoId, ...(name.trim() ? { name: name.trim() } : {}) })
                      setConfirming(false)
                      setFromId('')
                      setIntoId('')
                    }}
                  >
                    Move {from.played} {from.played === 1 ? 'match' : 'matches'} to{' '}
                    {into.name || 'the other id'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--tiny"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                // Two steps, like Delete: a merge cannot be undone by merging back, because the
                // id it moved off is gone from every row that used to carry it.
                <button
                  type="button"
                  className="btn btn--primary btn--tiny"
                  disabled={!ready}
                  onClick={() => setConfirming(true)}
                >
                  Merge
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/**
 * **D44 — recording a game that was not played here.**
 *
 * The rest of this screen corrects rows that a match object filed. This one has no match object
 * behind it: the laptop was flat, or the group played six games before anyone opened the site, and
 * the history is missing evenings that happened. Everything here is typed rather than read off a
 * log, which is exactly why it lives behind the same key as `edit` — see the note at the top.
 *
 * Two choices worth stating, because both were the other way in the first draft:
 *
 * **The rounds drive the score.** Touching a round button recomputes both scores and the winner
 * under D21's half-point rule, because typing "2–1" and then clicking A, B, A is doing the same
 * arithmetic twice and disagreeing with yourself is the likely outcome. Both stay editable
 * afterwards — a game this app has never refereed should still be recordable — but the common case
 * is three clicks rather than five fields.
 *
 * **A seat may be somebody with no player id.** A friend who has never opened the site has no id
 * to attribute a game to (D35: ids belong to browsers), and refusing them would make this useless
 * for precisely the evenings it exists to capture. The server mints one, it counts like any other,
 * and the merge control above is how it joins their real id later.
 */
function AddMatch({
  players,
  roster,
  disabled,
  onAdd,
}: {
  players: PlayerSummary[]
  roster: Character[]
  disabled: boolean
  onAdd: (entry: Parameters<typeof adminAddMatch>[1]) => void
}) {
  const [seats, setSeats] = useState<Record<'A' | 'B', SeatChoice>>({
    A: BLANK_SEAT,
    B: BLANK_SEAT,
  })
  const [scoreA, setScoreA] = useState('0')
  const [scoreB, setScoreB] = useState('0')
  const [winner, setWinner] = useState<'A' | 'B' | 'DRAW'>('DRAW')
  const [rounds, setRounds] = useState<(('A' | 'B' | 'TIE') | null)[]>([null, null, null, null])
  // D46 — one hero per seat per round. Empty until the admin picks, and sent only if they do.
  const [lineups, setLineups] = useState<Record<'A' | 'B', (string | null)[]>>(BLANK_LINEUPS)
  const [when, setWhen] = useState(today)

  /** What to call this seat on the buttons and above the score, before anything is stored. */
  const named = (seat: 'A' | 'B'): string => {
    const choice = seats[seat]
    if (choice.naming) return choice.name.trim()
    return players.find((p) => p.playerId === choice.id)?.name ?? ''
  }

  /*
   * A seat is settled once it names somebody — an id from the directory, or a name to mint one
   * for. Two seats resolving to the same id is the one combination the server refuses, so the
   * button refuses it first rather than spending a round trip to be told.
   */
  const settled = (seat: 'A' | 'B') =>
    seats[seat].naming ? named(seat) !== '' : seats[seat].id !== ''
  const clash = seats.A.id !== '' && seats.A.id === seats.B.id
  const ready = settled('A') && settled('B') && !clash

  const choose = (seat: 'A' | 'B', value: string) =>
    setSeats((prev) => ({
      ...prev,
      [seat]: value === NEW ? { id: '', naming: true, name: '' } : { ...BLANK_SEAT, id: value },
    }))

  const submit = () => {
    // The id when there is one, and the *directory's* name beside it: that is what every other
    // screen calls this player, and a record captioned differently reads as somebody else. An
    // empty name is left out rather than sent — the server reads the claimed one, which is a
    // better answer than blanking the caption.
    const seatFields = (seat: 'A' | 'B') => {
      const name = named(seat)
      return {
        ...(seats[seat].naming ? {} : { [seat === 'A' ? 'aId' : 'bId']: seats[seat].id }),
        ...(name ? { [seat === 'A' ? 'aName' : 'bName']: name } : {}),
      }
    }

    onAdd({
      ...seatFields('A'),
      ...seatFields('B'),
      winnerId: winner === 'DRAW' ? null : winner,
      scoreA: Number(scoreA) || 0,
      scoreB: Number(scoreB) || 0,
      ...(rounds.some((r) => r !== null) ? { rounds } : {}),
      // Sent per seat and only when that seat has a hero on it, so a match added without them is
      // stored exactly as D44 stored it: a result, and no claim about who played.
      ...(lineups.A.some(Boolean) ? { aLineup: lineups.A } : {}),
      ...(lineups.B.some(Boolean) ? { bLineup: lineups.B } : {}),
      playedAt: playedAtFrom(when),
    })

    setSeats({ A: BLANK_SEAT, B: BLANK_SEAT })
    setScoreA('0')
    setScoreB('0')
    setWinner('DRAW')
    setRounds([null, null, null, null])
    setLineups(BLANK_LINEUPS)
  }

  return (
    <section className="panel">
      <h2 className="panel__title">Add a match</h2>
      <p className="field__help">
        For a game played away from the site. It counts on the leaderboard exactly like a game
        played here, and the history marks it as added by hand rather than reported by both seats.
      </p>

      {disabled ? (
        <p className="panel__empty">Enter the admin key to add a match.</p>
      ) : (
        <div className="addmatch">
          {(['A', 'B'] as const).map((seat) => (
            <div className="addmatch__seat" key={seat}>
              <label className="field">
                <span className="field__label">Seat {seat}</span>
                <select
                  className="field__input"
                  aria-label={`Player in seat ${seat}`}
                  value={seats[seat].naming ? NEW : seats[seat].id}
                  onChange={(e) => choose(seat, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {players.map((p) => (
                    <option key={p.playerId} value={p.playerId}>
                      {p.name || 'Unnamed'} — {p.playerId}
                    </option>
                  ))}
                  <option value={NEW}>Somebody not listed…</option>
                </select>
              </label>

              {seats[seat].naming ? (
                <label className="field">
                  <span className="field__label">Their name</span>
                  <input
                    className="field__input"
                    aria-label={`Name for seat ${seat}`}
                    value={seats[seat].name}
                    onChange={(e) =>
                      setSeats((prev) => ({
                        ...prev,
                        [seat]: { id: '', naming: true, name: e.target.value },
                      }))
                    }
                    placeholder="somebody with no player id yet"
                  />
                  <span className="adminrow__hint">
                    gets a new player id — merge it into their real one once they play here
                  </span>
                </label>
              ) : null}
            </div>
          ))}

          <div className="adminrow__line">
            <span className="adminrow__label">Rounds</span>
            {rounds.map((result, i) => (
              <button
                key={i}
                type="button"
                className="btn btn--tiny"
                aria-label={`Round ${i + 1} of the match being added`}
                onClick={() => {
                  const next = rounds.map((r, j) => (j === i ? nextOutcome(r) : r))
                  setRounds(next)
                  // The score and the winner follow, so the common case is clicking the rounds and
                  // pressing Add. Both stay editable below, for the game this cannot work out.
                  const [a, b] = scoreRounds(next)
                  setScoreA(String(a))
                  setScoreB(String(b))
                  setWinner(a > b ? 'A' : b > a ? 'B' : 'DRAW')
                }}
              >
                {i >= 3 ? 'OT' : `R${i + 1}`}:{' '}
                {result === null ? '—' : result === 'TIE' ? 'Tie' : result}
              </button>
            ))}
          </div>

          <Lineup
            rounds={rounds.length}
            roster={roster}
            lineups={lineups}
            label="of the match being added"
            onChange={(seat, round, id) =>
              setLineups((prev) => setHero(prev, seat, round, id, rounds.length))
            }
          />

          <div className="adminrow__grid">
            <span className="adminrow__label">{named('A') || 'Seat A'}</span>
            <input
              className="field__input adminrow__score"
              aria-label="Score for seat A"
              value={scoreA}
              onChange={(e) => setScoreA(e.target.value)}
            />
            <span className="adminrow__vs">vs</span>
            <input
              className="field__input adminrow__score"
              aria-label="Score for seat B"
              value={scoreB}
              onChange={(e) => setScoreB(e.target.value)}
            />
            <span className="adminrow__label">{named('B') || 'Seat B'}</span>
          </div>

          <div className="adminrow__line">
            <span className="adminrow__label">Winner</span>
            {(['A', 'B', 'DRAW'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`btn btn--tiny ${winner === option ? 'btn--on' : ''}`}
                onClick={() => setWinner(option)}
              >
                {option === 'DRAW' ? 'Draw' : named(option) || `Seat ${option}`}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="field__label">Played on</span>
            <input
              className="field__input"
              type="date"
              aria-label="Date it was played"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
            <p className="field__help">
              The history sorts on this, so an evening from last month lands where it happened
              rather than at the top of the page.
            </p>
          </label>

          <div className="adminrow__actions">
            <button
              type="button"
              className="btn btn--primary btn--tiny"
              disabled={!ready}
              onClick={submit}
            >
              Add match
            </button>
            {ready ? null : (
              <span className="adminrow__hint">
                {clash ? 'both seats are the same player' : 'choose or name both players'}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * One seat of the match being added.
 *
 * `naming` rather than an empty id, because "nobody chosen yet" and "somebody I am about to name"
 * are different states that both have no id, and collapsing them is what makes a name field
 * appear before anyone asked for one.
 */
interface SeatChoice {
  id: string
  naming: boolean
  name: string
}

const BLANK_SEAT: SeatChoice = { id: '', naming: false, name: '' }

/** The select value meaning "not one of these". Never a player id — those are all `p_`-prefixed. */
const NEW = '—new—'

/** D21's half-point rule, applied to whatever rounds have been filled in so far. */
function scoreRounds(rounds: (('A' | 'B' | 'TIE') | null)[]): [number, number] {
  let a = 0
  let b = 0
  for (const result of rounds) {
    if (result === 'A') a += 1
    else if (result === 'B') b += 1
    else if (result === 'TIE') {
      a += 0.5
      b += 0.5
    }
  }
  return [a, b]
}

/** `yyyy-mm-dd` in the local timezone, which is what a `date` input wants. */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

/**
 * A date field to a timestamp.
 *
 * Midday local rather than midnight, and not `Date.parse` of the bare string: that reads
 * `yyyy-mm-dd` as UTC, so anywhere west of Greenwich a game played today is filed as yesterday —
 * which is the one thing this field exists to get right. Today keeps the current clock time, so a
 * game added now sorts above one added this morning rather than tying with it.
 */
function playedAtFrom(value: string): number {
  if (value === today()) return Date.now()
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return Date.now()
  return new Date(y, m - 1, d, 12).getTime()
}

function EditRow({
  match,
  players,
  roster,
  disabled,
  onSave,
  onDelete,
}: {
  match: MatchRecord
  players: PlayerSummary[]
  roster: Character[]
  disabled: boolean
  onSave: (patch: Parameters<typeof adminEditMatch>[1]) => void
  onDelete: () => void
}) {
  const detail = match.detail as MatchDetail | null
  /** Bound out so the narrowing survives into the callback; absent on a D44 record. */
  const seats = detail?.seats
  const [aName, setAName] = useState(match.a.name)
  const [bName, setBName] = useState(match.b.name)
  const [aId, setAId] = useState(match.a.id)
  const [bId, setBId] = useState(match.b.id)
  const [scoreA, setScoreA] = useState(String(match.scoreA))
  const [scoreB, setScoreB] = useState(String(match.scoreB))
  const [winner, setWinner] = useState<'A' | 'B' | 'DRAW'>(
    match.winnerId === null ? 'DRAW' : match.winnerId === match.a.id ? 'A' : 'B',
  )
  const [rounds, setRounds] = useState<(('A' | 'B' | 'TIE') | null)[]>(detail?.rounds ?? [])
  /*
   * D46 — the heroes, seeded from what is stored.
   *
   * A record from before D45 has none, and this is where one gets them: the match's own log is
   * long gone, so the dashboard is the only place its rounds can be attributed to a hero at all.
   */
  const [lineups, setLineups] = useState(() => lineupsOf(detail, detail?.rounds?.length ?? 0))
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="adminrow">
      <div className="adminrow__head">
        <code className="adminrow__code">{match.roomCode}</code>
        <span className="adminrow__when">{new Date(match.playedAt).toLocaleDateString()}</span>
      </div>

      <div className="adminrow__grid">
        <input
          className="field__input"
          aria-label={`Name for seat A in ${match.roomCode}`}
          value={aName}
          onChange={(e) => setAName(e.target.value)}
        />
        <input
          className="field__input adminrow__score"
          aria-label={`Score for seat A in ${match.roomCode}`}
          value={scoreA}
          onChange={(e) => setScoreA(e.target.value)}
        />
        <span className="adminrow__vs">vs</span>
        <input
          className="field__input adminrow__score"
          aria-label={`Score for seat B in ${match.roomCode}`}
          value={scoreB}
          onChange={(e) => setScoreB(e.target.value)}
        />
        <input
          className="field__input"
          aria-label={`Name for seat B in ${match.roomCode}`}
          value={bName}
          onChange={(e) => setBName(e.target.value)}
        />
      </div>

      {/*
       * D35 — who this match actually belongs to. A select of known ids rather than a text field:
       * the ids are opaque UUIDs, and typing one is an invitation to reassign a game to a player
       * that does not exist. Read-only text until there is a key, since the directory it would
       * choose from is behind that key.
       */}
      {(['A', 'B'] as const).map((seat) => {
        const current = seat === 'A' ? aId : bId
        const set = seat === 'A' ? setAId : setBId
        const original = seat === 'A' ? match.a.id : match.b.id
        return (
          <div className="adminrow__line" key={seat}>
            <span className="adminrow__label">Seat {seat}</span>
            {players.length === 0 ? (
              <>
                <code className="playerrow__id">{current}</code>
                {/*
                 * Says why rather than just showing inert text. The control needs the directory
                 * to have something to offer, the directory needs an accepted key, and a plain
                 * id with no explanation beside it reads as "this one cannot be changed" — which
                 * is the opposite of true and the exact wrong conclusion to leave someone with.
                 */}
                <span className="adminrow__hint">
                  reassigning needs an accepted admin key — the list of players comes with it
                </span>
              </>
            ) : (
              <select
                className="field__input adminrow__who"
                aria-label={`Player in seat ${seat} of ${match.roomCode}`}
                value={current}
                onChange={(e) => set(e.target.value)}
              >
                {/* The id on the row comes first even when the directory does not contain it —
                    a match can outlive every name claim its players ever made. */}
                {players.some((p) => p.playerId === current) ? null : (
                  <option value={current}>{current}</option>
                )}
                {players.map((p) => (
                  <option key={p.playerId} value={p.playerId}>
                    {p.name || 'Unnamed'} — {p.playerId}
                  </option>
                ))}
              </select>
            )}
            {current !== original ? <span className="adminrow__hint">was {original}</span> : null}
          </div>
        )
      })}

      <div className="adminrow__line">
        <span className="adminrow__label">Winner</span>
        {(['A', 'B', 'DRAW'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={`btn btn--tiny ${winner === option ? 'btn--on' : ''}`}
            onClick={() => setWinner(option)}
          >
            {option === 'DRAW' ? 'Draw' : option === 'A' ? aName || 'Seat A' : bName || 'Seat B'}
          </button>
        ))}
      </div>

      {rounds.length > 0 ? (
        <div className="adminrow__line">
          <span className="adminrow__label">Rounds</span>
          {rounds.map((result, i) => (
            <button
              key={i}
              type="button"
              className="btn btn--tiny"
              // Cycles rather than opening a menu: four states, one control, and the label always
              // says which one it is on.
              onClick={() =>
                setRounds((prev) => prev.map((r, j) => (j === i ? nextOutcome(r) : r)))
              }
            >
              {i >= 3 ? 'OT' : `R${i + 1}`}:{' '}
              {result === null ? '—' : result === 'TIE' ? 'Tie' : result === 'A' ? 'A' : 'B'}
            </button>
          ))}
        </div>
      ) : null}

      <Lineup
        rounds={rounds.length}
        roster={roster}
        lineups={lineups}
        label={`in ${match.roomCode}`}
        onChange={(seat, round, id) =>
          setLineups((prev) => setHero(prev, seat, round, id, rounds.length))
        }
      />

      {/*
       * The drafted rosters, read-only and identical to what the history page shows. They are not
       * editable here on purpose: a wrong score is a typo someone made, a wrong roster would be a
       * different game. Their job is to let you recognise the match you are about to edit, which
       * a room code and a date do not do a month later.
       */}
      {seats ? (
        <div className="hrosters">
          {(['A', 'B'] as const).map((seat) => (
            <Roster key={seat} name={seat === 'A' ? aName : bName} side={seats[seat]} />
          ))}
        </div>
      ) : null}

      <div className="adminrow__actions">
        <button
          type="button"
          className="btn btn--primary btn--tiny"
          disabled={disabled}
          onClick={() =>
            onSave({
              roomCode: match.roomCode,
              aName,
              bName,
              aId,
              bId,
              winnerId: winner === 'DRAW' ? null : winner,
              ...(Number.isFinite(Number(scoreA)) ? { scoreA: Number(scoreA) } : {}),
              ...(Number.isFinite(Number(scoreB)) ? { scoreB: Number(scoreB) } : {}),
              rounds,
              // Both sent whole rather than as a patch: a seat's lineup is what this form is
              // showing, and half of one is indistinguishable from a round meant to be cleared.
              aLineup: lineups.A,
              bLineup: lineups.B,
            })
          }
        >
          Save
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn--danger btn--tiny"
              disabled={disabled}
              onClick={onDelete}
            >
              Really delete
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--tiny"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          // Two steps, because this is the one control here with no undo behind it — the record
          // is all that survives a match whose room has expired.
          <button
            type="button"
            className="btn btn--quiet btn--tiny"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        )}
        {disabled ? <span className="adminrow__hint">Enter the admin key to edit.</span> : null}
      </div>
    </li>
  )
}

/**
 * **D46 — who played what, round by round.**
 *
 * One row per round, both seats on it, because a round *is* a matchup: the hero board counts
 * these in pairs and reading them in pairs is how you notice you have put a hero on the wrong
 * side of one. Laid out on the same grid as the score line above, so the two seats stay in the
 * same two columns everywhere on the row.
 *
 * A select rather than a text field, for the reason the seat controls already are: these are ids,
 * the server refuses one that is not on the roster, and nobody should have to know that
 * `moon-elf` is spelled with a hyphen.
 *
 * Renders nothing without a roster. The list is the control — an empty menu is not a degraded
 * version of this, it is a control that cannot do anything.
 */
function Lineup({
  rounds,
  roster,
  lineups,
  label,
  onChange,
}: {
  rounds: number
  roster: Character[]
  lineups: Record<'A' | 'B', (string | null)[]>
  /** Distinguishes these selects from the other form's on a screen that has both. */
  label: string
  onChange: (seat: 'A' | 'B', round: number, characterId: string | null) => void
}) {
  if (roster.length === 0 || rounds === 0) return null

  return (
    <div className="lineup">
      <span className="adminrow__label">Heroes</span>
      {Array.from({ length: rounds }, (_, round) => (
        <div className="lineup__round" key={round}>
          {/* Index 3 is D30's overtime round, which is not the fourth round of anything. */}
          <span className="lineup__index">{round >= 3 ? 'OT' : `R${round + 1}`}</span>
          {(['A', 'B'] as const).map((seat) => (
            <select
              key={seat}
              className="field__input lineup__pick"
              aria-label={`Hero for seat ${seat} in round ${round + 1} ${label}`}
              value={lineups[seat][round] ?? ''}
              onChange={(e) => onChange(seat, round, e.target.value || null)}
            >
              <option value="">—</option>
              {roster.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              {/*
               * A hero the roster no longer lists still has to be selectable on a row that
               * already holds it — otherwise opening this row and saving would quietly drop it.
               * D14 retires rather than deletes, so this is rare and not impossible.
               */}
              {lineups[seat][round] && !roster.some((c) => c.id === lineups[seat][round]) ? (
                <option value={lineups[seat][round]!}>{lineups[seat][round]}</option>
              ) : null}
            </select>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Sets one round of one seat's lineup, padding to length so round 3 can be set before round 1. */
function setHero(
  lineups: Record<'A' | 'B', (string | null)[]>,
  seat: 'A' | 'B',
  round: number,
  characterId: string | null,
  rounds: number,
): Record<'A' | 'B', (string | null)[]> {
  const next = Array.from({ length: rounds }, (_, i) => lineups[seat][i] ?? null)
  next[round] = characterId
  return { ...lineups, [seat]: next }
}

/** The lineup a stored match already has, padded to the rounds it has. */
function lineupsOf(
  detail: MatchDetail | null,
  rounds: number,
): Record<'A' | 'B', (string | null)[]> {
  const of = (seat: 'A' | 'B') =>
    Array.from({ length: rounds }, (_, i) => detail?.seats?.[seat]?.lineup?.[i] ?? null)
  return { A: of('A'), B: of('B') }
}

/** A → B → Tie → unplayed → A. `null` is a round `stopWhenDecided` meant nobody played. */
function nextOutcome(current: ('A' | 'B' | 'TIE') | null): ('A' | 'B' | 'TIE') | null {
  if (current === 'A') return 'B'
  if (current === 'B') return 'TIE'
  if (current === 'TIE') return null
  return 'A'
}

function noop(): void {}

/** Four rounds of nobody, which is what a fresh add form shows. */
const BLANK_LINEUPS: Record<'A' | 'B', (string | null)[]> = {
  A: [null, null, null, null],
  B: [null, null, null, null],
}
