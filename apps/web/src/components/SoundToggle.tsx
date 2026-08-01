import { useState } from 'react'

import { play, setSoundEnabled, soundEnabled } from '../sound.js'

/**
 * Sound is off until asked for.
 *
 * Two reasons, and only one of them is manners. The other is that browsers give no audio until
 * the page has been interacted with, so an unmuted default produces silence *and* a wrong
 * expectation — the first cue a player should hear is the one that follows their own click on
 * this button.
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
        // Confirm it out loud, since the only way to know sound works is to hear some.
        if (next) play('reveal')
      }}
    >
      <span aria-hidden="true">{on ? '♪' : '♪'}</span>
    </button>
  )
}
