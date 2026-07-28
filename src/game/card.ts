import type { Player } from './player'

export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'] as const

export type Suit = (typeof SUITS)[number]
export type Rank = (typeof RANKS)[number]

export type Card = {
  id: string
  rank: Rank
  suit: Suit
}

export type PlayedCard = { card: Card; player: Player }

const rankValue: Record<Rank, number> = { '9': 0, '10': 1, J: 2, Q: 3, K: 4, A: 5 }

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => {
    return RANKS.map((rank) => {
      return { id: `${rank}-${suit}`, rank, suit }
    })
  })
}

export function shuffle<T>(items: readonly T[]): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

export function sameColorSuit(suit: Suit): Suit {
  if (suit === 'clubs') {
    return 'spades'
  }
  if (suit === 'spades') {
    return 'clubs'
  }
  if (suit === 'diamonds') {
    return 'hearts'
  }
  return 'diamonds'
}

export function effectiveSuit(card: Card, trump: Suit): Suit {
  if (card.rank === 'J' && card.suit === sameColorSuit(trump)) {
    return trump
  }
  return card.suit
}

export function hasNaturalTrump(hand: readonly Card[], trump: Suit): boolean {
  return hand.some((card) => {
    return card.suit === trump
  })
}

export function strength(card: Card, lead: Suit, trump: Suit): number {
  if (card.rank === 'J' && card.suit === trump) {
    return 200
  }
  if (card.rank === 'J' && card.suit === sameColorSuit(trump)) {
    return 199
  }
  const suit = effectiveSuit(card, trump)
  if (suit === trump) {
    return 100 + rankValue[card.rank]
  }
  if (suit === lead) {
    return 50 + rankValue[card.rank]
  }
  return rankValue[card.rank]
}

export function legalCards(
  hand: readonly Card[],
  trick: readonly PlayedCard[],
  trump: Suit,
): Card[] {
  if (trick.length === 0) {
    return [...hand]
  }
  const lead = effectiveSuit(trick[0].card, trump)
  const following = hand.filter((card) => {
    return effectiveSuit(card, trump) === lead
  })
  return following.length > 0 ? following : [...hand]
}

export function trickWinner(trick: readonly PlayedCard[], trump: Suit): Player {
  if (trick.length === 0) {
    throw new Error('Cannot score an empty trick.')
  }
  const lead = effectiveSuit(trick[0].card, trump)
  return trick.reduce((best, played) => {
    return strength(played.card, lead, trump) > strength(best.card, lead, trump) ? played : best
  }).player
}

export function sortHand(hand: readonly Card[], trump: Suit | null): Card[] {
  return [...hand].sort((a, b) => {
    if (!trump) {
      return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || rankValue[a.rank] - rankValue[b.rank]
    }
    const suitOrder = [
      ...SUITS.filter((suit) => {
        return suit !== trump
      }),
      trump,
    ]
    const suitA = effectiveSuit(a, trump)
    const suitB = effectiveSuit(b, trump)
    return (
      suitOrder.indexOf(suitA) - suitOrder.indexOf(suitB) ||
      strength(a, suitA, trump) - strength(b, suitB, trump)
    )
  })
}
