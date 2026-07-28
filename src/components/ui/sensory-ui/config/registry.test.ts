import { describe, expect, it } from 'vitest'
import { ALL_SOUND_ROLES } from './sound-roles'
import { mergeConfig, resolveRole } from './config'
import { packRegistry } from './registry'

describe('sound registry resolution', () => {
  it('resolves every standard role under default and crisp config', () => {
    const enabled = mergeConfig({ categories: { hero: true } })
    const crispEnabled = mergeConfig({ theme: 'crisp', categories: { hero: true } })
    for (const role of ALL_SOUND_ROLES) {
      const defaultSource = resolveRole(role, enabled)
      const crispSource = resolveRole(role, crispEnabled)
      expect(defaultSource).not.toBeNull()
      expect(crispSource).toBe(defaultSource)
      expect(crispSource).toBe(packRegistry.crisp[role])
      expect(typeof defaultSource === 'function' || typeof defaultSource === 'string').toBe(true)
    }
  })

  it('lets custom per-role URL overrides win over the crisp pack', () => {
    const config = mergeConfig({
      theme: 'crisp',
      overrides: {
        'interaction.tap': '/sounds/custom-tap.mp3',
      },
    })

    expect(resolveRole('interaction.tap', config)).toBe('/sounds/custom-tap.mp3')
    expect(resolveRole('interaction.subtle', config)).toBe(packRegistry.crisp['interaction.subtle'])
  })

  it('returns null for disabled categories', () => {
    const config = mergeConfig({
      categories: {
        hero: false,
        interaction: true,
        overlay: true,
        navigation: true,
        notification: true,
      },
    })

    expect(resolveRole('hero.complete', config)).toBeNull()
    expect(resolveRole('interaction.tap', config)).toBe(packRegistry.crisp['interaction.tap'])
  })

  it('keeps crisp hero roles as synthesizer definitions', () => {
    const complete = resolveRole('hero.complete', mergeConfig({ categories: { hero: true } }))
    const milestone = resolveRole('hero.milestone', mergeConfig({ categories: { hero: true } }))

    expect(typeof complete).toBe('function')
    expect(typeof milestone).toBe('function')
  })

  it('falls unknown theme strings back to crisp', () => {
    const config = mergeConfig({ theme: 'industrial' })
    expect(resolveRole('interaction.tap', config)).toBe(packRegistry.crisp['interaction.tap'])
  })
})
