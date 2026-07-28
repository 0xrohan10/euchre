import type { GameRules } from './rules'

export type GameHistorySeat = {
  seat: number
  userId: string | null
  name: string
  controller: 'human' | 'bot'
}

export type GameHistorySummary = {
  id: string
  score: [number, number]
  winner: 0 | 1
  handCount: number
  rules: GameRules
  seats: GameHistorySeat[]
  completedAt: Date
}
