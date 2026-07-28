import { DEFAULT_RULES, type GameRules } from '../game/rules'

export const RULES_STORAGE_KEY = 'kitty-rules:v1'

export function loadStoredRules(): GameRules {
  try {
    const raw = localStorage.getItem(RULES_STORAGE_KEY) ?? localStorage.getItem('kitty-rules')
    const saved = JSON.parse(raw ?? 'null') as Partial<GameRules> | null
    if (
      saved &&
      typeof saved.stickDealer === 'boolean' &&
      typeof saved.requireNaturalTrump === 'boolean' &&
      typeof saved.allowAloneWhenOrderingPartner === 'boolean'
    ) {
      return { ...DEFAULT_RULES, ...saved }
    }
  } catch {
    /* Keep the standard rules when saved preferences are unreadable. */
  }
  return { ...DEFAULT_RULES }
}
