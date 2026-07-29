import { useMemo, useState } from 'react'
import type { Character, CharId } from '@banpick/types'

import { getFavourites, getRecents, toggleFavourite } from '../favourites.js'

/**
 * Picking from ~75 characters.
 *
 * O6: *"Drafting 4 from ~75 is a search-and-filter problem, not a grid. Text search,
 * favourites, and recents are requirements, not polish."*
 *
 * The pool is **given**, never computed. It arrives inside a `legalActions` entry, already
 * differenced against global bans, meta bans, and D12's self-duplicate rule (§6). This
 * component filters that list for *findability* and nothing else — anything it excluded on its
 * own would be a second implementation of the rules.
 */

export interface CharacterPickerProps {
  /** Legal choices, from the server. Everything outside this is not shown as disabled — it is absent. */
  pool: CharId[]
  roster: Character[]
  selected: CharId[]
  onSelect: (id: CharId) => void
  /** Reached, but not yet at capacity. Drives the "N more" affordance. */
  remaining: number
  label: string
  help?: string
}

type Filter = 'all' | 'favourites' | 'recents'

export function CharacterPicker({
  pool,
  roster,
  selected,
  onSelect,
  remaining,
  label,
  help,
}: CharacterPickerProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [favourites, setFavourites] = useState<CharId[]>(() => getFavourites())
  const recents = useMemo(() => getRecents(), [])

  const byId = useMemo(() => new Map(roster.map((c) => [c.id, c])), [roster])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return pool
      .map((id) => byId.get(id))
      .filter((c): c is Character => c !== undefined)
      .filter((c) => {
        if (filter === 'favourites' && !favourites.includes(c.id)) return false
        if (filter === 'recents' && !recents.includes(c.id)) return false
        if (!needle) return true
        // Blurb is searched too — at 75 characters people remember what someone *does* long
        // before they remember the name.
        return (
          c.name.toLowerCase().includes(needle) ||
          c.id.includes(needle) ||
          c.blurb.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        const favDelta = Number(favourites.includes(b.id)) - Number(favourites.includes(a.id))
        return favDelta !== 0 ? favDelta : a.name.localeCompare(b.name)
      })
  }, [pool, byId, query, filter, favourites, recents])

  return (
    <section className="picker" aria-label={label}>
      <header className="picker__head">
        <h2 className="picker__title">{label}</h2>
        <p className="picker__count" aria-live="polite">
          {remaining > 0 ? `Choose ${remaining} more` : 'Ready'}
        </p>
      </header>

      {help ? <p className="picker__help">{help}</p> : null}

      <div className="picker__controls">
        <input
          className="picker__search"
          type="search"
          value={query}
          placeholder={`Search ${pool.length} characters`}
          aria-label="Search characters"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="picker__filters" role="group" aria-label="Filter">
          {(['all', 'favourites', 'recents'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`chip ${filter === f ? 'chip--on' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              disabled={
                f === 'favourites'
                  ? favourites.length === 0
                  : f === 'recents'
                    ? recents.length === 0
                    : false
              }
            >
              {f === 'all' ? 'All' : f === 'favourites' ? '★ Favourites' : 'Recent'}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="picker__empty">
          {query ? `Nothing matches “${query}”.` : 'Nothing available here.'}
        </p>
      ) : (
        <ul className="picker__list">
          {visible.map((character) => {
            const isSelected = selected.includes(character.id)
            return (
              <li key={character.id}>
                <div className={`card ${isSelected ? 'card--on' : ''}`}>
                  <button
                    type="button"
                    className="card__body"
                    aria-pressed={isSelected}
                    onClick={() => onSelect(character.id)}
                  >
                    <span className="card__name">{character.name}</span>
                    <span className="card__blurb">{character.blurb}</span>
                  </button>
                  <button
                    type="button"
                    className={`card__fav ${favourites.includes(character.id) ? 'card__fav--on' : ''}`}
                    aria-label={
                      favourites.includes(character.id)
                        ? `Remove ${character.name} from favourites`
                        : `Add ${character.name} to favourites`
                    }
                    aria-pressed={favourites.includes(character.id)}
                    onClick={() => setFavourites(toggleFavourite(character.id))}
                  >
                    ★
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
