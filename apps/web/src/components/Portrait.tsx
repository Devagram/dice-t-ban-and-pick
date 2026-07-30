import { useState } from 'react'
import type { Character } from '@banpick/types'

import { artFor, hueFor, initialsOf } from '../art.js'

/**
 * A character's face, at one of three sizes.
 *
 * Falls back to initials on a per-character hue when there is no art — and also when an image
 * *fails to load*, which is the case that matters if the art directory is ever stripped from a
 * deployment while the manifest still names files. A broken-image icon in a draft grid would be
 * worse than no picture at all.
 */
export function Portrait({
  character,
  size = 'card',
  dimmed = false,
}: {
  character: Character
  size?: 'card' | 'chip' | 'slot'
  dimmed?: boolean
}) {
  const src = artFor(character.id)
  const [failed, setFailed] = useState(false)
  const showArt = src !== null && !failed

  return (
    <span
      className={`portrait portrait--${size} ${dimmed ? 'portrait--dim' : ''}`}
      style={showArt ? undefined : ({ '--hue': hueFor(character.id) } as React.CSSProperties)}
      aria-hidden="true"
    >
      {showArt ? (
        <img
          className="portrait__img"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="portrait__initials">{initialsOf(character.name)}</span>
      )}
    </span>
  )
}
