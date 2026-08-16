import { useEffect, useState } from 'react'

import {
  ApiError,
  adminDeleteMatch,
  adminEditMatch,
  adminFetchPlayers,
  adminMergePlayers,
  fetchMatches,
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
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    fetchMatches()
      .then(setMatches)
      .catch(() => setError('Could not load matches.'))
  }
  useEffect(reload, [])

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

function EditRow({
  match,
  players,
  disabled,
  onSave,
  onDelete,
}: {
  match: MatchRecord
  players: PlayerSummary[]
  disabled: boolean
  onSave: (patch: Parameters<typeof adminEditMatch>[1]) => void
  onDelete: () => void
}) {
  const detail = match.detail as MatchDetail | null
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

      {/*
       * The drafted rosters, read-only and identical to what the history page shows. They are not
       * editable here on purpose: a wrong score is a typo someone made, a wrong roster would be a
       * different game. Their job is to let you recognise the match you are about to edit, which
       * a room code and a date do not do a month later.
       */}
      {detail?.seats ? (
        <div className="hrosters">
          {(['A', 'B'] as const).map((seat) => (
            <Roster key={seat} name={seat === 'A' ? aName : bName} side={detail.seats[seat]} />
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

/** A → B → Tie → unplayed → A. `null` is a round `stopWhenDecided` meant nobody played. */
function nextOutcome(current: ('A' | 'B' | 'TIE') | null): ('A' | 'B' | 'TIE') | null {
  if (current === 'A') return 'B'
  if (current === 'B') return 'TIE'
  if (current === 'TIE') return null
  return 'A'
}

function noop(): void {}
