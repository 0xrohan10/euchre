import type { Card, PlayedCard, Suit } from './card'
import type { Player, Team } from './player'
import type { GameRules } from './rules'
import type { HandResult, RatingMode } from './skill'

export type GameState = {
  phase:
    | 'exchanging'
    | 'ordering'
    | 'calling'
    | 'discarding'
    | 'playing'
    | 'trick-complete'
    | 'hand-over'
    | 'match-over'
  dealer: Player
  activePlayer: Player
  hands: [Card[], Card[], Card[], Card[]]
  kitty: Card[]
  upCard: Card
  trump: Suit | null
  maker: Player | null
  lonePlayer: Player | null
  exchangedPlayer: Player | null
  trick: PlayedCard[]
  tricks: [number, number]
  playerTricks: [number, number, number, number]
  wonTricks: [PlayedCard[][], PlayedCard[][], PlayedCard[][], PlayedCard[][]]
  score: [number, number]
  handNumber: number
  lastTrickWinner: Player | null
  notice: string
  rules: GameRules
  handResults?: HandResult[]
  initialHands?: [Card[], Card[], Card[], Card[]]
  ratingEvidenceComplete?: boolean
  ratingMode?: RatingMode
  ratingParticipants?: [string | null, string | null, string | null, string | null]
  ratingForfeitTeam?: Team
  ratingBotSeats?: [boolean, boolean, boolean, boolean]
}

export function emptyWonTricks(): GameState['wonTricks'] {
  return [[], [], [], []]
}

export type GameAction =
  | { type: 'exchange-kitty' }
  | { type: 'decline-exchange' }
  | { type: 'pass' }
  | { type: 'order-up'; alone?: boolean }
  | { type: 'call-trump'; suit: Suit; alone?: boolean }
  | { type: 'discard'; cardId: string }
  | { type: 'play'; cardId: string }
  | { type: 'collect-trick' }
  | { type: 'next-hand' }
  | { type: 'new-match' }
  | { type: 'set-rule'; rule: keyof GameRules; enabled: boolean }
