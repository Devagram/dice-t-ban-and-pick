import { useEffect, useState } from 'react'

import {
  createTournament,
  fetchMatchups,
  listModes,
  type CreatedTournament,
  type EntrantInput,
  type ModeSummary,
  type TournamentConfigInput,
} from '../api.js'

/**
 * **D37 Phase 9 — where a tournament comes from.**
 *
 * The plan built eight phases of tournament and no way to start one: `POST /api/tournament` worked
 * and nothing in the app called it, so the whole layer was reachable only with `curl`. That is the
 * gap this screen closes, and it is worth naming rather than quietly filling — every phase had an
 * exit criterion and none of them was "a person can create one".
 *
 * Two things here are more than a form.
 *
 * **Identity.** An entrant needs a player id, and a player id belongs to a *browser* (D35), which
 * the organizer is not sitting at. So known names are matched against the public history and reuse
 * the real id — the common case for a regular group, which is exactly §1's trust model — and an
 * unrecognised name gets a fresh one, said out loud, because a tournament silently minting a
 * second identity for somebody is precisely the D35 problem being manufactured on purpose.
 *
 * **The tokens.** The response carries the organizer key and one link per entrant, and they exist
 * nowhere else — only hashes are stored. Whatever this screen fails to show is gone, so it shows
 * all of it, offers it as text to copy, and says plainly that reloading loses it.
 */

/** A name typed by the organizer, resolved against the people this deployment already knows. */
interface Resolved extends EntrantInput {
  /** False when the id was minted here — the entrant starts with no record attached. */
  known: boolean
}

const POSITION_LABEL: Record<string, string> = {
  LOSERS: 'Losers bracket',
  GRAND_FINAL: 'Final',
}

export function NewTournament({ onBack }: { onBack: () => void }) {
  const [modes, setModes] = useState<ModeSummary[]>([])
  const [directory, setDirectory] = useState<Map<string, string>>(new Map())
  const [names, setNames] = useState('')
  const [format, setFormat] = useState<'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION'>(
    'SINGLE_ELIMINATION',
  )
  const [grandFinalReset, setGrandFinalReset] = useState(true)
  const [seeding, setSeeding] = useState<'AS_ENTERED' | 'RANDOM'>('AS_ENTERED')
  const [defaultMode, setDefaultMode] = useState('base')
  /** Empty means "same as the default" — the fallback the server already applies (`chainFor`). */
  const [overrides, setOverrides] = useState<Record<string, string>>({
    LOSERS: '',
    GRAND_FINAL: '',
  })
  const [created, setCreated] = useState<CreatedTournament | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    listModes()
      .then(setModes)
      .catch(() => setError('Could not load the mode list.'))

    /*
     * The public matchup table doubles as a name directory: every row names both players and
     * their ids. Not `/api/admin/players`, which would put the whole screen behind the admin key
     * to answer a question the history already answers in the open.
     */
    fetchMatchups()
      .then((rows) => {
        const found = new Map<string, string>()
        for (const row of rows) {
          for (const side of [row.a, row.b]) {
            if (side.name) found.set(side.name.trim().toLowerCase(), side.id)
          }
        }
        setDirectory(found)
      })
      .catch(() => {
        // A deployment with no history yet. Every entrant is simply new, which is true.
      })
  }, [])

  const entrants: Resolved[] = names
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((displayName) => {
      const existing = directory.get(displayName.toLowerCase())
      return {
        displayName: displayName.slice(0, 40),
        playerId: existing ?? mintedId(displayName),
        known: existing !== undefined,
      }
    })

  const duplicates = entrants.length !== new Set(entrants.map((e) => e.playerId)).size
  const countOk = entrants.length >= 2 && entrants.length <= 32

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const config: TournamentConfigInput = {
        format,
        seeding,
        grandFinalReset,
        default: { modeId: defaultMode },
        overrides: Object.fromEntries(
          Object.entries(overrides)
            .filter(([, modeId]) => modeId.length > 0)
            .map(([position, modeId]) => [position, { modeId }]),
        ),
      }
      setCreated(
        await createTournament({
          entrants: entrants.map(({ playerId, displayName }) => ({ playerId, displayName })),
          config,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (created) return <Handover created={created} entrants={entrants} />

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">New tournament</h1>
        <p className="hero__sub">Any mode, any bracket · up to 32</p>
        <button type="button" className="btn btn--quiet" onClick={onBack}>
          Back
        </button>
      </header>

      {error ? (
        <p className="alert" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel">
        <h2 className="panel__title">Entrants</h2>
        <label className="field">
          <span className="field__label">One name per line</span>
          <textarea
            className="field__input"
            aria-label="Entrants, one name per line"
            rows={8}
            value={names}
            onChange={(e) => setNames(e.target.value)}
            placeholder={'Tom\nAlex\nSam\nJo'}
          />
          <p className="field__help">
            A name that has played here before keeps its record. Anyone else starts fresh — there is
            no login to look them up by, so this is a guess from the history and a new id when it
            misses.
          </p>
        </label>

        {entrants.length > 0 ? (
          <ol className="tentrants">
            {entrants.map((entrant, i) => (
              <li key={`${entrant.playerId}:${i}`} className="tentrant">
                <span className="tentrant__seed">{i + 1}</span>
                <span className="tentrant__name">{entrant.displayName}</span>
                <span className="tentrant__note">
                  {entrant.known ? 'known player' : 'new — will not join an existing record'}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {duplicates ? (
          <p className="alert" role="alert">
            The same person is entered twice. A bracket cannot contain somebody twice.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel__title">Bracket</h2>

        <fieldset className="field">
          <legend className="field__label">Format</legend>
          <div className="modes" role="radiogroup" aria-label="Format">
            {(
              [
                {
                  value: 'SINGLE_ELIMINATION',
                  name: 'Single elimination',
                  blurb: 'One loss and you are out.',
                },
                {
                  value: 'DOUBLE_ELIMINATION',
                  name: 'Double elimination',
                  blurb: 'A loss drops you to the losers bracket, which can play its own mode.',
                },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={format === option.value}
                className={`modecard ${format === option.value ? 'modecard--on' : ''}`}
                onClick={() => setFormat(option.value)}
              >
                <span className="modecard__name">{option.name}</span>
                <span className="modecard__blurb">{option.blurb}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {format === 'DOUBLE_ELIMINATION' ? (
          <fieldset className="field">
            <legend className="field__label">Bracket reset in the grand final</legend>
            <p className="field__help">
              On is the standard rule and the reason double elimination is fair (D40): somebody
              arriving from the losers bracket has a loss already, so they have to win twice.
            </p>
            <div className="segmented" role="group">
              {[
                { value: true, label: 'Reset' },
                { value: false, label: 'One match' },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  className={`chip ${grandFinalReset === option.value ? 'chip--on' : ''}`}
                  aria-pressed={grandFinalReset === option.value}
                  onClick={() => setGrandFinalReset(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        <fieldset className="field">
          <legend className="field__label">Seeding</legend>
          <div className="segmented" role="group">
            {[
              { value: 'AS_ENTERED', label: 'In the order above' },
              { value: 'RANDOM', label: 'Random draw' },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                className={`chip ${seeding === option.value ? 'chip--on' : ''}`}
                aria-pressed={seeding === option.value}
                onClick={() => setSeeding(option.value as 'AS_ENTERED' | 'RANDOM')}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="panel">
        <h2 className="panel__title">Modes</h2>
        <p className="field__help">
          Every match is played under the default unless a position says otherwise. A Bo1 losers
          bracket under a Bo3 winners bracket is the point of this section.
        </p>

        <ModePicker
          label="Every match"
          modes={modes}
          value={defaultMode}
          onChange={setDefaultMode}
        />
        {Object.keys(overrides)
          .filter((position) => position !== 'LOSERS' || format === 'DOUBLE_ELIMINATION')
          .map((position) => (
            <ModePicker
              key={position}
              label={POSITION_LABEL[position] ?? position}
              modes={modes}
              value={overrides[position] ?? ''}
              sameAsDefault
              onChange={(modeId) => setOverrides((o) => ({ ...o, [position]: modeId }))}
            />
          ))}
      </section>

      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || !countOk || duplicates}
        onClick={() => void submit()}
      >
        {busy ? 'Creating…' : 'Create tournament'}
      </button>
      {!countOk ? (
        <p className="field__help">
          Between 2 and 32 entrants. The cap is D42’s, and it is enforced by the server too.
        </p>
      ) : null}
    </main>
  )
}

function ModePicker({
  label,
  modes,
  value,
  onChange,
  sameAsDefault = false,
}: {
  label: string
  modes: ModeSummary[]
  value: string
  onChange: (modeId: string) => void
  sameAsDefault?: boolean
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select
        className="field__input"
        aria-label={`Mode for ${label}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {sameAsDefault ? <option value="">Same as the default</option> : null}
        {modes.map((mode) => (
          <option key={mode.modeId} value={mode.modeId}>
            {mode.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The one screen in the app that cannot be reloaded.
 *
 * Everything here is a bearer credential minted once (D41), and the server kept only hashes. So it
 * is all on screen at once, copyable in one block, and says what losing it costs — an entrant's
 * link can be re-minted by the organizer, and the organizer's cannot be re-minted by anybody.
 */
function Handover({ created, entrants }: { created: CreatedTournament; entrants: Resolved[] }) {
  const block = [
    `Tournament ${created.code}`,
    `Bracket: ${created.url}`,
    `Organiser: ${origin()}/t/${created.code}/run`,
    `Organiser key: ${created.organizerToken}`,
    '',
    ...created.entrants.map((e) => `${e.displayName}: ${e.url}`),
  ].join('\n')

  return (
    <main className="screen">
      <header className="hero">
        <h1 className="title">{created.code}</h1>
        <p className="hero__sub">Created · hand these out</p>
        <a className="btn btn--primary" href={`/t/${created.code}`}>
          Open the bracket
        </a>
        <a className="btn btn--quiet" href={`/t/${created.code}/run`}>
          Organiser console
        </a>
      </header>

      <p className="alert alert--notice" role="status">
        These links exist here and nowhere else — the server stored only hashes of them. Copy them
        before you leave this page.
      </p>

      <section className="panel">
        <h2 className="panel__title">Organiser key</h2>
        <p className="field__help">
          Not the admin key, and not recoverable. Lose it and this tournament has no organiser: no
          settling a dispute, no correcting a result, no substitutions.
        </p>
        <code className="handover__token">{created.organizerToken}</code>
      </section>

      <section className="panel">
        <h2 className="panel__title">Entrant links</h2>
        <ul className="handover">
          {created.entrants.map((entrant, i) => (
            <li key={entrant.entrantId} className="handover__row">
              <span className="handover__name">
                {entrant.displayName}
                {entrants[i] && !entrants[i].known ? ' · new player' : ''}
              </span>
              <code className="handover__link">{entrant.url}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel__title">All of it, to paste somewhere</h2>
        <textarea
          className="field__input"
          readOnly
          rows={10}
          value={block}
          aria-label="Everything"
        />
      </section>
    </main>
  )
}

/** `location.origin`, but survives a test environment that has not got one. */
function origin(): string {
  return typeof location === 'undefined' ? '' : location.origin
}

/**
 * A player id for somebody this deployment has never seen.
 *
 * Shaped like `player.ts`'s so nothing downstream can tell them apart, because nothing downstream
 * should: it is a real id that simply has no matches behind it yet. D41's relink attaches the
 * entrant's own browser later; D35's merge fixes it afterwards if nobody did.
 */
function mintedId(seed: string): string {
  return `p_t_${hash(seed)}`
}

/** Deterministic, so re-rendering the same list does not churn the ids under the preview. */
function hash(text: string): string {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
