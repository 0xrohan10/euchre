import type { SoundRole } from '../config/sound-roles'
import type { SoundSynthesizer, PlaySoundOptions, SoundPlayback } from '../config/engine'
import { CRISP_INSTRUMENT } from './core/instruments'
import { generateSoundPack } from './core/pack-generator'

type GeneratedSoundPack = Record<SoundRole, SoundSynthesizer>

// ---------------------------------------------------------------------------
// Note frequencies for crisp hero sounds
// ---------------------------------------------------------------------------
const NOTES = {
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0,
  C6: 1046.5,
}

// ---------------------------------------------------------------------------
// Crisp Pack - Sharp, articulated rapid arpeggios
// ---------------------------------------------------------------------------

const crispHeroComplete: SoundSynthesizer = (
  ctx: AudioContext,
  opts: PlaySoundOptions,
): SoundPlayback => {
  const t = ctx.currentTime
  const vol = (opts.volume ?? 1) * 0.6
  // Pentatonic scale run with crisp attack
  const notes = [NOTES.C5, NOTES.D5, NOTES.E5, NOTES.G5, NOTES.A5, NOTES.C6]
  const oscs: OscillatorNode[] = []

  notes.forEach((freq, i) => {
    const noteStart = t + i * 0.08
    const isLast = i === notes.length - 1
    const dur = isLast ? 0.35 : 0.06

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq * 1.1

    const g = ctx.createGain()
    g.gain.setValueAtTime(0.001, noteStart)
    g.gain.linearRampToValueAtTime(vol, noteStart + 0.003)
    g.gain.exponentialRampToValueAtTime(0.001, noteStart + dur)

    osc.connect(g)
    g.connect(ctx.destination)
    oscs.push(osc)

    osc.start(noteStart)
    osc.stop(noteStart + dur + 0.02)

    if (isLast) {
      osc.onended = () => {
        oscs.forEach((o) => {
          try {
            o.disconnect()
          } catch {}
        })
        opts.onEnd?.()
      }
    }
  })

  return {
    stop: () => {
      return oscs.forEach((o) => {
        try {
          o.stop()
        } catch {}
      })
    },
  }
}

const crispHeroMilestone: SoundSynthesizer = (
  ctx: AudioContext,
  opts: PlaySoundOptions,
): SoundPlayback => {
  const t = ctx.currentTime
  const vol = (opts.volume ?? 1) * 0.55
  // Pentatonic skip pattern
  const notes = [NOTES.C5, NOTES.D5, NOTES.G5, NOTES.C6]
  const oscs: OscillatorNode[] = []

  notes.forEach((freq, i) => {
    const noteStart = t + i * 0.07
    const isLast = i === notes.length - 1
    const dur = isLast ? 0.25 : 0.05

    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq * 1.1

    const g = ctx.createGain()
    g.gain.setValueAtTime(0.001, noteStart)
    g.gain.linearRampToValueAtTime(vol, noteStart + 0.002)
    g.gain.exponentialRampToValueAtTime(0.001, noteStart + dur)

    osc.connect(g)
    g.connect(ctx.destination)
    oscs.push(osc)

    osc.start(noteStart)
    osc.stop(noteStart + dur + 0.02)

    if (isLast) {
      osc.onended = () => {
        oscs.forEach((o) => {
          try {
            o.disconnect()
          } catch {}
        })
        opts.onEnd?.()
      }
    }
  })

  return {
    stop: () => {
      return oscs.forEach((o) => {
        try {
          o.stop()
        } catch {}
      })
    },
  }
}

export const crispPack: GeneratedSoundPack = {
  ...generateSoundPack(CRISP_INSTRUMENT),
  'hero.complete': crispHeroComplete,
  'hero.milestone': crispHeroMilestone,
}
