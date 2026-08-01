/**
 * Cues, synthesised.
 *
 * Web Audio rather than sample files, for the same reason the fonts are subset and self-hosted:
 * nothing ships that we did not generate. Nine short cues built from oscillators and filtered
 * noise cost about a hundred lines and zero bytes of payload.
 *
 * **Muted by default.** Sound that arrives uninvited is a bug in someone's open-plan office, and
 * autoplay policy would block it on first load anyway — a browser gives no audio until the user
 * has interacted with the page, so an unmuted default would produce silence *and* a broken
 * expectation. The toggle persists, so it is one click per browser and never again.
 *
 * Every cue is fired from the same place as its animation, so sound and motion cannot disagree
 * about what just happened.
 */

const KEY = 'banpick:sound'

export type Cue =
  'hover' | 'pick' | 'unpick' | 'ban' | 'lockIn' | 'dice' | 'reveal' | 'win' | 'lose'

let context: AudioContext | null = null
let enabled = read()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    // Private browsing. Silence is the safe default.
    return false
  }
}

export function soundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // Nothing depends on it persisting; the toggle still works for this session.
  }
}

/**
 * The context is created lazily, on the first cue after the user has enabled sound.
 *
 * Constructing one before a user gesture leaves it `suspended` on every browser with an autoplay
 * policy, and a suspended context that nobody resumes is silence that looks like a bug.
 */
function audio(): AudioContext | null {
  if (!enabled) return null
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    return context
  } catch {
    return null
  }
}

interface ToneOptions {
  /** Hz at the start, and at the end if it should slide. */
  from: number
  to?: number
  ms: number
  type?: OscillatorType
  /** Peak gain. These are all quiet — a UI cue should sit under conversation. */
  gain?: number
  delay?: number
}

function tone({ from, to, ms, type = 'sine', gain = 0.06, delay = 0 }: ToneOptions): void {
  const ctx = audio()
  if (!ctx) return

  const at = ctx.currentTime + delay
  const osc = ctx.createOscillator()
  const amp = ctx.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(from, at)
  if (to !== undefined) osc.frequency.exponentialRampToValueAtTime(to, at + ms / 1000)

  // An envelope rather than a hard start and stop, which would click.
  amp.gain.setValueAtTime(0.0001, at)
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.012)
  amp.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000)

  osc.connect(amp).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + ms / 1000 + 0.02)
}

/** Filtered noise — the rattle of dice, and the body of a hit. */
function noise(ms: number, gain = 0.05, cutoff = 1800): void {
  const ctx = audio()
  if (!ctx) return

  const frames = Math.floor((ctx.sampleRate * ms) / 1000)
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) {
    // Decaying, so it reads as an impact rather than a hiss.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames)
  }

  const src = ctx.createBufferSource()
  src.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = cutoff
  const amp = ctx.createGain()
  amp.gain.value = gain

  src.connect(filter).connect(amp).connect(ctx.destination)
  src.start()
}

export function play(cue: Cue): void {
  switch (cue) {
    case 'hover':
      tone({ from: 900, ms: 40, gain: 0.015, type: 'triangle' })
      return
    case 'pick':
      // Up a fifth: something added.
      tone({ from: 440, to: 660, ms: 110, type: 'triangle', gain: 0.05 })
      return
    case 'unpick':
      // The same interval, downward. Taking back should sound like the inverse of putting down.
      tone({ from: 660, to: 440, ms: 110, type: 'triangle', gain: 0.04 })
      return
    case 'ban':
      tone({ from: 180, to: 70, ms: 260, type: 'sawtooth', gain: 0.07 })
      noise(180, 0.05, 900)
      return
    case 'lockIn':
      // Two voices arriving together — the pair, not one player.
      tone({ from: 520, to: 780, ms: 260, type: 'sine', gain: 0.05 })
      tone({ from: 660, to: 990, ms: 260, type: 'sine', gain: 0.035, delay: 0.06 })
      return
    case 'dice':
      noise(90, 0.06, 2600)
      noise(70, 0.045, 2200)
      return
    case 'reveal':
      tone({ from: 700, to: 1050, ms: 150, type: 'triangle', gain: 0.04 })
      return
    case 'win':
      // A rising triad, spaced so it reads as a phrase rather than a chord.
      tone({ from: 523, ms: 160, type: 'triangle', gain: 0.06 })
      tone({ from: 659, ms: 160, type: 'triangle', gain: 0.06, delay: 0.13 })
      tone({ from: 784, ms: 420, type: 'triangle', gain: 0.07, delay: 0.26 })
      return
    case 'lose':
      tone({ from: 392, to: 262, ms: 520, type: 'sine', gain: 0.05 })
      return
  }
}
