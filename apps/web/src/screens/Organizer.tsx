import { useEffect, useState } from 'react'

import { fetchTournament, type BracketSlot, type TournamentView } from '../api.js'

/**
 * **D37 Phase 7 — the organizer console.**
 *
 * Reached at `/t/:code/run`, and gated by a token minted once when the tournament was created —
 * deliberately **not** `ADMIN_KEY`. That key is deployment-wide and gates rewriting every recorded
 * result in the deployment; running Thursday's event should not require it.
 *
 * Every action here overrules somebody, so every one of them is **two steps and names what it will
 * affect** — the standard `/admin` already set. The correction is the sharpest case: it shows the
 * matches that were already played downstream *before* it is applied, because whether a game that
 * really happened still counts is a judgement about the evening and not a thing this screen should
 * make on the organizer's behalf.
 */
const KEY_STORAGE = (code: string): string => `banpick.organizer.${code}`

function storedKey(code: string): string {
  try {
    return localStorage.getItem(KEY_STORAGE(code)) ?? ''
  } catch {
    return ''
  }
}

export function Organizer({ code, onBack }: { code: string; onBack: () => void }) {
  const [key, setKey] = useState(() => storedKey(code))
  const [view, setView] = useState<TournamentView | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = (): void => {
    fetchTournament(code)
      .then(setView)
      .catch(() => setError('Could not load that tournament.'))
  }
  useEffect(reload, [code])

  const remember = (value: string): void => {
    setKey(value)
    try {
      localStorage.setItem(KEY_STORAGE(code), value)
    } catch {
      // Private browsing. The key still works for this session, as `player.ts` has always traded.
    }
  }

  async function act(action: string, body: unknown, done: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/tournament/${code}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-organizer-key': key },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { detail?: string }
      setNotice(null)
      // The server's own words where it has any. "That did not go through" is a dead end when the
      // real answer is "you have not said why" or "somebody has already played".
      setError(detail.detail ?? 'That did not go through. Check the organiser key.')
      return
    }
    setNotice(done)
    reload()
  }

  if (!view) {
    return (
      <main className="screen">
        <p className="panel__empty">{error ?? 'Loading…'}</p>
      </main>
    )
  }

  const nameOf = (entrantId: string | null): string =>
    view.entrants.find((e) => e.entrantId === entrantId)?.displayName ?? '—'

  /** The slots an organizer is actually here for: stuck, or already decided and possibly wrong. */
  const stuck = view.slots.filter(
    (s) => s.status === 'DISPUTED' || s.status === 'DRAWN' || s.status === 'READY',
  )
  const decided = view.slots.filter((s) => s.winner !== null)

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">Run {view.code}</h1>
        <p className="hero__sub">Organiser console</p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      <section className="panel">
        <label className="field">
          <span className="field__label">Organiser key</span>
          <input
            className="field__input"
            type="password"
            aria-label="Organiser key"
            value={key}
            onChange={(e) => remember(e.target.value)}
            placeholder="shown once, when the tournament was created"
          />
          <p className="field__help">
            Not the admin key. This one was handed over once when the tournament was created and is
            stored nowhere on the server but as a hash — if it is lost, this tournament has no
            organiser.
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
        <h2 className="panel__title">Needs a decision</h2>
        {stuck.length === 0 ? (
          <p className="panel__empty">Nothing is waiting on you.</p>
        ) : (
          <ul className="adminlist">
            {stuck.map((slot) => (
              <SettleRow
                key={slot.slot.id}
                slot={slot}
                nameOf={nameOf}
                disabled={key.length === 0}
                onResolve={(winner, reason) =>
                  void act(
                    'resolve',
                    { slotId: slot.slot.id, winnerEntrantId: winner, reason },
                    `${slot.slot.id} settled.`,
                  )
                }
                onVoid={(reason) =>
                  void act('voidSlot', { slotId: slot.slot.id, reason }, `${slot.slot.id} voided.`)
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Correct a result</h2>
        <p className="field__help">
          Changing a result the bracket has already acted on re-derives everything after it. Matches
          that were <strong>already played</strong> downstream are listed before anything is applied
          — voiding them is your call, not the app’s.
        </p>
        {decided.length === 0 ? (
          <p className="panel__empty">Nothing has been decided yet.</p>
        ) : (
          <ul className="adminlist">
            {decided.map((slot) => (
              <CorrectRow
                key={slot.slot.id}
                slot={slot}
                code={code}
                nameOf={nameOf}
                disabled={key.length === 0}
                onCorrect={(winner, reason, voidDownstream) =>
                  void act(
                    'correct',
                    { slotId: slot.slot.id, winnerEntrantId: winner, reason, voidDownstream },
                    `${slot.slot.id} corrected.`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

/** Settling a slot: pick a winner and say why, or void it and say why. Two steps either way. */
function SettleRow({
  slot,
  nameOf,
  disabled,
  onResolve,
  onVoid,
}: {
  slot: BracketSlot
  nameOf: (id: string | null) => string
  disabled: boolean
  onResolve: (winner: string, reason: string) => void
  onVoid: (reason: string) => void
}) {
  const [winner, setWinner] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="adminrow">
      <div className="adminrow__head">
        <code className="adminrow__code">{slot.slot.id}</code>
        <span className="adminrow__when">
          {slot.status.toLowerCase()} · {slot.modeId}
        </span>
      </div>
      <div className="adminrow__line">
        {slot.entrants.map((entrantId) => (
          <button
            key={entrantId ?? 'none'}
            type="button"
            className={`btn btn--tiny ${winner === entrantId ? 'btn--on' : ''}`}
            disabled={entrantId === null}
            onClick={() => {
              setWinner(entrantId ?? '')
              setConfirming(false)
            }}
          >
            {nameOf(entrantId)}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field__label">Why</span>
        <input
          className="field__input"
          aria-label={`Reason for ${slot.slot.id}`}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value)
            setConfirming(false)
          }}
          placeholder="no-show, agreed at the table, coin toss…"
        />
      </label>
      <div className="adminrow__actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="btn btn--danger btn--tiny"
              onClick={() => {
                if (winner) onResolve(winner, reason)
                else onVoid(reason)
                setConfirming(false)
              }}
            >
              {winner ? `Really give it to ${nameOf(winner)}` : 'Really void it'}
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
          <button
            type="button"
            className="btn btn--primary btn--tiny"
            disabled={disabled || reason.trim().length === 0}
            onClick={() => setConfirming(true)}
          >
            {winner ? 'Award it' : 'Void it'}
          </button>
        )}
        {disabled ? <span className="adminrow__hint">Enter the organiser key.</span> : null}
        {reason.trim().length === 0 ? (
          // Required by the server too. Said here so the button explains itself rather than
          // failing after the click.
          <span className="adminrow__hint">A reason is required — this goes in the log.</span>
        ) : null}
      </div>
    </li>
  )
}

/** Correcting a decided slot, with the cascade fetched and shown before it is applied. */
function CorrectRow({
  slot,
  code,
  nameOf,
  disabled,
  onCorrect,
}: {
  slot: BracketSlot
  code: string
  nameOf: (id: string | null) => string
  disabled: boolean
  onCorrect: (winner: string, reason: string, voidDownstream: boolean) => void
}) {
  const [reason, setReason] = useState('')
  const [cascade, setCascade] = useState<{ played: string[]; pending: string[] } | null>(null)
  const [voidDownstream, setVoidDownstream] = useState(false)

  const other = slot.entrants.find((e) => e !== null && e !== slot.winner) ?? null

  const preview = async (): Promise<void> => {
    const response = await fetch(`/api/tournament/${code}/cascade`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slotId: slot.slot.id }),
    })
    setCascade(
      response.ok ? ((await response.json()) as { played: string[]; pending: string[] }) : null,
    )
  }

  return (
    <li className="adminrow">
      <div className="adminrow__head">
        <code className="adminrow__code">{slot.slot.id}</code>
        <span className="adminrow__when">won by {nameOf(slot.winner)}</span>
      </div>

      {cascade ? (
        <div className="adminrow__line">
          <span className="adminrow__label">Affects</span>
          <span className="adminrow__hint">
            {cascade.pending.length > 0
              ? `${cascade.pending.join(', ')} recompute. `
              : 'nothing is waiting. '}
            {cascade.played.length > 0
              ? `${cascade.played.join(', ')} were already played.`
              : 'Nothing downstream has been played.'}
          </span>
        </div>
      ) : null}

      <label className="field">
        <span className="field__label">Why</span>
        <input
          className="field__input"
          aria-label={`Reason for correcting ${slot.slot.id}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reported the wrong way round"
        />
      </label>

      {cascade && cascade.played.length > 0 ? (
        <label className="adminrow__line">
          <input
            type="checkbox"
            checked={voidDownstream}
            onChange={(e) => setVoidDownstream(e.target.checked)}
          />
          <span className="adminrow__hint">
            Also void {cascade.played.join(', ')} — they were played between people who may not both
            have got there.
          </span>
        </label>
      ) : null}

      <div className="adminrow__actions">
        {cascade === null ? (
          <button type="button" className="btn btn--quiet btn--tiny" onClick={() => void preview()}>
            Show what this affects
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--tiny"
            disabled={disabled || !other || reason.trim().length === 0}
            onClick={() => other && onCorrect(other, reason, voidDownstream)}
          >
            Give {slot.slot.id} to {nameOf(other)}
          </button>
        )}
        {disabled ? <span className="adminrow__hint">Enter the organiser key.</span> : null}
      </div>
    </li>
  )
}
