import { useState } from 'react'

import { play, setSoundEnabled, soundEnabled } from '../sound.js'

/**
 * Sound is on by default; this turns it off.
 *
 * The choice persists, so it is one click per browser. Turning it back *on* replies with a cue,
 * because the only way to know sound works is to hear some — and because a browser will not have
 * produced any audio before the click that this button is.
 */
export function SoundToggle() {
  const [on, setOn] = useState(soundEnabled)

  return (
    <button
      type="button"
      className={`soundtoggle ${on ? 'soundtoggle--on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Sound on' : 'Sound off'}
      title={on ? 'Sound on' : 'Sound off'}
      onClick={() => {
        const next = !on
        setSoundEnabled(next)
        setOn(next)
        // Confirm it out loud, since the only way to know sound works is to hear some — and this
        // click is a user gesture, so it is the first moment the browser will allow any.
        if (next) play('reveal')
      }}
    >
      <span aria-hidden="true">{on ? '♪' : '♪'}</span>
    </button>
  )
}
