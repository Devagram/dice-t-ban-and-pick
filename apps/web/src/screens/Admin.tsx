import { useEffect, useState } from 'react'

import {
  adminDeleteMatch,
  adminEditMatch,
  fetchMatches,
  type MatchDetail,
  type MatchRecord,
} from '../api.js'

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
 */
const KEY_STORAGE = 'banpick.adminKey'

export function Admin({ onBack }: { onBack: () => void }) {
  const [key, setKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? '')
  const [matches, setMatches] = useState<MatchRecord[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = () => {
    fetchMatches()
      .then(setMatches)
      .catch(() => setError('Could not load matches.'))
  }
  useEffect(reload, [])

  const remember = (value: string) => {
    setKey(value)
    // Kept in this browser only, like the seat token and the player name (§17's trade). Losing
    // the browser loses it, and that is the same deal everything else here makes.
    localStorage.setItem(KEY_STORAGE, value)
  }

  const run = (work: Promise<unknown>, done: string) => {
    setError(null)
    work
      .then(() => {
        setNotice(done)
        reload()
      })
      .catch(() => {
        setNotice(null)
        setError(
          'That did not go through. Check the admin key — the server refuses edits without it.',
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
          <p className="field__help">
            Set on the Worker with <code>wrangler secret put ADMIN_KEY</code>. Until one is
            configured the server has no admin at all and refuses every edit.
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
                key={m.roomCode}
                match={m}
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

function EditRow({
  match,
  disabled,
  onSave,
  onDelete,
}: {
  match: MatchRecord
  disabled: boolean
  onSave: (patch: Parameters<typeof adminEditMatch>[1]) => void
  onDelete: () => void
}) {
  const detail = match.detail as MatchDetail | null
  const [aName, setAName] = useState(match.a.name)
  const [bName, setBName] = useState(match.b.name)
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
