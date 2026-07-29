import { useEffect, useState } from 'react'
import type { Character } from '@banpick/types'

import { createMatch, fetchRoster, listModes, type ModeSummary } from '../api.js'
import { MODE_BLURBS } from '../copy.js'

/**
 * §12.1 — the host selects mode, **its parameters** (D25), and the global ban list.
 *
 * The parameter space comes from the server, already validated at every declared combination.
 * The client renders the choices it was given and cannot offer one that was never checked.
 */
export function Home({ onCreated }: { onCreated: (roomCode: string) => void }) {
  const [modes, setModes] = useState<ModeSummary[]>([])
  const [modeId, setModeId] = useState('base')
  const [parameters, setParameters] = useState<Record<string, string | number>>({})
  const [globalBanned, setGlobalBanned] = useState<string[]>([])
  const [roster, setRoster] = useState<Character[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listModes()
      .then((list) => {
        setModes(list)
        const first = list.find((m) => m.modeId === 'base') ?? list[0]
        if (first) {
          setModeId(first.modeId)
          setParameters(defaultsOf(first))
        }
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    // Names for the ban list. Its own endpoint, because a host choosing bans has no match yet
    // and conjuring a Durable Object per page load to read public display data would be absurd.
    fetchRoster()
      .then((r) => setRoster(r.characters))
      .catch(() => {
        // Not fatal: the optional ban list simply is not offered.
      })
  }, [])

  const mode = modes.find((m) => m.modeId === modeId)

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await createMatch({ modeId, parameters, globalBanned })
      onCreated(created.roomCode)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen">
      <h1 className="title">Ban &amp; Pick</h1>

      <section className="panel">
        <h2 className="panel__title">Start a match</h2>

        <label className="field">
          <span className="field__label">Mode</span>
          <select
            className="field__input"
            value={modeId}
            onChange={(e) => {
              const next = modes.find((m) => m.modeId === e.target.value)
              setModeId(e.target.value)
              if (next) setParameters(defaultsOf(next))
            }}
          >
            {modes.map((m) => (
              <option key={m.modeId} value={m.modeId}>
                {m.label.replace(/\$\{\w+\}/g, '…')}
              </option>
            ))}
          </select>
        </label>
        <p className="field__help">{MODE_BLURBS[modeId] ?? ''}</p>

        {mode
          ? Object.entries(mode.parameters).map(([name, spec]) => (
              <fieldset key={name} className="field">
                <legend className="field__label">{spec.label}</legend>
                <div className="segmented" role="group">
                  {spec.values.map((value) => (
                    <button
                      key={String(value)}
                      type="button"
                      className={`chip ${parameters[name] === value ? 'chip--on' : ''}`}
                      aria-pressed={parameters[name] === value}
                      onClick={() => setParameters((p) => ({ ...p, [name]: value }))}
                    >
                      {String(value)}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))
          : null}

        {roster.length > 0 ? (
          <fieldset className="field">
            <legend className="field__label">Ban for tonight (optional)</legend>
            <p className="field__help">Out for both of you, before anything else.</p>
            <div className="banlist">
              {roster.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chip ${globalBanned.includes(c.id) ? 'chip--ban' : ''}`}
                  aria-pressed={globalBanned.includes(c.id)}
                  onClick={() =>
                    setGlobalBanned((b) =>
                      b.includes(c.id) ? b.filter((x) => x !== c.id) : [...b, c.id],
                    )
                  }
                >
                  {c.name}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        <button type="button" className="btn btn--primary" disabled={busy} onClick={create}>
          Create match
        </button>
      </section>

      <section className="panel">
        <h2 className="panel__title">Join a match</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (joinCode.trim()) location.assign(`/j/${joinCode.trim().toUpperCase()}`)
          }}
        >
          <label className="field">
            <span className="field__label">Room code</span>
            <input
              className="field__input field__input--code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
            />
          </label>
          <button type="submit" className="btn" disabled={joinCode.trim().length !== 6}>
            Join
          </button>
        </form>
      </section>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  )
}

function defaultsOf(mode: ModeSummary): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [name, spec] of Object.entries(mode.parameters)) out[name] = spec.default
  return out
}
