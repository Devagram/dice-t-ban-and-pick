import { describe, expect, it, beforeEach, vi } from 'vitest'

import { play, setSoundEnabled, soundEnabled } from '../src/sound.js'

/**
 * Sound, and the two things it must never do.
 *
 * It must not play uninvited, and it must not throw. Cues fire from inside animation callbacks
 * and effects all over the client — a `sound.ts` that raised on a browser without `AudioContext`,
 * or in a test environment that has none, would take a render down with it for the sake of a
 * noise nobody asked for.
 */

beforeEach(() => {
  localStorage.clear()
  setSoundEnabled(false)
  vi.unstubAllGlobals()
})

describe('sound is off until asked for', () => {
  it('starts muted', () => {
    expect(soundEnabled()).toBe(false)
  })

  it('never touches the audio API while muted', () => {
    // Constructing a context before a user gesture leaves it suspended on every browser with an
    // autoplay policy — silence that looks like a bug.
    const ctor = vi.fn()
    vi.stubGlobal('AudioContext', ctor)

    for (const cue of ['pick', 'ban', 'lockIn', 'dice', 'win'] as const) play(cue)
    expect(ctor).not.toHaveBeenCalled()
  })

  it('persists the choice, so it is one click per browser', () => {
    setSoundEnabled(true)
    expect(soundEnabled()).toBe(true)
    expect(localStorage.getItem('banpick:sound')).toBe('on')

    setSoundEnabled(false)
    expect(localStorage.getItem('banpick:sound')).toBe('off')
  })
})

describe('sound never takes a render down with it', () => {
  it('survives an environment with no AudioContext at all', () => {
    // happy-dom has none, which is exactly the case a cue fired from an effect would hit.
    setSoundEnabled(true)
    expect(() => {
      for (const cue of [
        'hover',
        'pick',
        'unpick',
        'ban',
        'lockIn',
        'dice',
        'reveal',
        'win',
        'lose',
      ] as const) {
        play(cue)
      }
    }).not.toThrow()
  })

  it('survives an AudioContext that refuses to construct', () => {
    setSoundEnabled(true)
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('blocked by policy')
        }
      },
    )
    expect(() => play('win')).not.toThrow()
  })

  it('survives storage being unavailable', () => {
    // Private browsing throws on both read and write.
    const boom = () => {
      throw new Error('denied')
    }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => setSoundEnabled(true)).not.toThrow()
  })
})
