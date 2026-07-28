import type { SoundRole } from './sound-roles'
import type { SoundSource } from './engine'
import { crispPack } from '../sounds/crisp-pack'

/**
 * A complete mapping of every SoundRole to a SoundSource for one pack.
 * SoundSource is either a SoundSynthesizer function (preferred) or a
 * base64 data URI / public-path string (for custom user overrides).
 */
export type SoundPack = Record<SoundRole, SoundSource>

/**
 * Application-facing built-in sound packs.
 * Only the active crisp pack is shipped in the root client graph.
 */
export const packRegistry = {
  crisp: crispPack,
} as const

export type SoundPackName = keyof typeof packRegistry

/**
 * Default sound pack name for the application registry.
 */
export const DEFAULT_PACK: SoundPackName = 'crisp'

/**
 * Backwards-compat alias: the default pack's role → source mapping.
 */
export const roleRegistry: SoundPack = crispPack
