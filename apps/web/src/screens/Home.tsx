import { useEffect, useState } from 'react'
import type { Character } from '@banpick/types'

import { createMatch, fetchRoster, listModes, type ModeSummary } from '../api.js'
import { MODE_BLURBS } from '../copy.js'
import { Portrait } from '../components/Portrait.js'

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
  /** D28 — the host's answer; `rulesetFor` on the server turns it into a rule. */
  const [allowRepeatBans, setAllowRepeatBans] = useState(false)
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
      const created = await createMatch({ modeId, parameters, globalBanned, allowRepeatBans })
      onCreated(created.roomCode)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen">
      {/* The front door should look like the thing it opens. */}
      <header className="hero">
        <h1 className="title">Ban &amp; Pick</h1>
        <p className="hero__sub">Dice Throne · draft, ban, and settle it</p>
        <div className="hero__links">
          {/* Ahead of the leaderboard: joining a game is what someone arriving at the base URL
              most likely came to do, now that it is possible without a link. */}
          <a className="btn btn--primary" href="/lobbies">
            Join a game
          </a>
          <a className="btn btn--quiet" href="/leaderboard">
            Leaderboard
          </a>
          <a className="btn btn--quiet" href="/history">
            History
          </a>
        </div>
      </header>

      <section className="panel">
        <h2 className="panel__title">Start a match</h2>

        {/*
          Modes as cards rather than a `<select>`.
          
          There are two of them and the difference between them is the whole decision — a dropdown
          hides that behind a click and gives the blurb nowhere to live.
        */}
        <fieldset className="field">
          <legend className="field__label">Mode</legend>
          <div className="modes" role="radiogroup" aria-label="Mode">
            {modes.map((m) => (
              <button
                key={m.modeId}
                type="button"
                role="radio"
                aria-checked={modeId === m.modeId}
                className={`modecard ${modeId === m.modeId ? 'modecard--on' : ''}`}
                onClick={() => {
                  setModeId(m.modeId)
                  setParameters(defaultsOf(m))
                }}
              >
                <span className="modecard__name">{m.label.replace(/\$\{\w+\}/g, '…')}</span>
                <span className="modecard__blurb">{MODE_BLURBS[m.modeId] ?? ''}</span>
              </button>
            ))}
          </div>
        </fieldset>

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
            {/* Faces, not a wall of names. People recognise a portrait long before they read
                forty-five labels, and the banned ones grey out the way they do everywhere else. */}
            <div className="banlist">
              {roster.map((c) => {
                const banned = globalBanned.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`banpick ${banned ? 'banpick--on' : ''}`}
                    aria-pressed={banned}
                    title={c.blurb}
                    onClick={() =>
                      setGlobalBanned((b) =>
                        b.includes(c.id) ? b.filter((x) => x !== c.id) : [...b, c.id],
                      )
                    }
                  >
                    <Portrait character={c} size="head" dimmed={banned} />
                    <span className="banpick__name">{c.name}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="field">
          <legend className="field__label">Repeat bans</legend>
          <p className="field__help">
            Off, you cannot bring the same ban against the same person two sets running.
          </p>
          <div className="segmented" role="group">
            {[
              { value: false, label: 'Not allowed' },
              { value: true, label: 'Allowed' },
            ].map((option) => (
              <button
                key={String(option.value)}
                type="button"
                className={`chip ${allowRepeatBans === option.value ? 'chip--on' : ''}`}
                aria-pressed={allowRepeatBans === option.value}
                onClick={() => setAllowRepeatBans(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <button type="button" className="btn btn--primary" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create match'}
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
