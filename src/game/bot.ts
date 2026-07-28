import {
  type Card,
  type Suit,
  SUITS,
  effectiveSuit,
  hasNaturalTrump,
  legalCards,
  strength,
  trickWinner,
} from './card'
import { teamOf } from './player'
import type { GameAction, GameState } from './state'

function evaluateTrump(hand: readonly Card[], trump: Suit): { count: number; value: number } {
  let count = 0
  let value = 0
  for (const card of hand) {
    if (effectiveSuit(card, trump) !== trump) {
      if (card.rank === 'A') {
        value += 0.5
      }
      continue
    }

    count += 1
    if (card.rank === 'J' && card.suit === trump) {
      value += 4.5
    } else if (card.rank === 'J') {
      value += 4
    } else {
      value += { A: 2.25, K: 1.5, Q: 1, '10': 0.5, '9': 0.25 }[card.rank]
    }
  }
  return { count, value }
}

function wantsTrump(count: number, value: number, threshold = 5.75): boolean {
  return count >= 3 && value >= threshold
}

function cardCost(card: Card, trump: Suit): number {
  return strength(card, effectiveSuit(card, trump), trump)
}

function weakest(cards: readonly Card[], trump: Suit): Card {
  return [...cards].sort((a, b) => {
    return cardCost(a, trump) - cardCost(b, trump)
  })[0]
}

function chooseCard(state: GameState): Card {
  if (state.trump === null) {
    throw new Error('Cannot choose a card without trump.')
  }
  const trump = state.trump
  const player = state.activePlayer
  const cards = legalCards(state.hands[player], state.trick, trump)

  if (state.trick.length === 0) {
    const trumpCards = cards.filter((card) => {
      return effectiveSuit(card, trump) === trump
    })
    const makerIsLeading = state.maker !== null && teamOf(state.maker) === teamOf(player)
    if (makerIsLeading && trumpCards.length >= 2) {
      return [...trumpCards].sort((a, b) => {
        return cardCost(b, trump) - cardCost(a, trump)
      })[0]
    }
    const sideAce = cards.find((card) => {
      return card.rank === 'A' && effectiveSuit(card, trump) !== trump
    })
    return sideAce ?? weakest(cards, trump)
  }

  const currentWinner = trickWinner(state.trick, trump)
  if (teamOf(currentWinner) === teamOf(player)) {
    return weakest(cards, trump)
  }

  const winningCards = cards.filter((card) => {
    return trickWinner([...state.trick, { card, player }], trump) === player
  })
  return winningCards.length > 0 ? weakest(winningCards, trump) : weakest(cards, trump)
}

export function chooseBotAction(state: GameState): GameAction | null {
  if (state.phase === 'exchanging') {
    return { type: 'exchange-kitty' }
  }
  if (state.phase === 'discarding' && state.trump !== null) {
    return { type: 'discard', cardId: weakest(state.hands[state.dealer], state.trump).id }
  }
  if (state.phase === 'ordering') {
    if (state.exchangedPlayer === state.activePlayer) {
      return { type: 'pass' }
    }
    if (
      state.rules.requireNaturalTrump &&
      !hasNaturalTrump(state.hands[state.activePlayer], state.upCard.suit)
    ) {
      return { type: 'pass' }
    }
    const hand =
      state.activePlayer === state.dealer
        ? [...state.hands[state.activePlayer], state.upCard]
        : state.hands[state.activePlayer]
    const { count, value } = evaluateTrump(hand, state.upCard.suit)
    const opponentDealer = teamOf(state.activePlayer) !== teamOf(state.dealer)
    const orderingPartner = state.activePlayer !== state.dealer && !opponentDealer
    const mayGoAlone = !orderingPartner || state.rules.allowAloneWhenOrderingPartner
    return wantsTrump(count, value, opponentDealer ? 6.5 : 5.5)
      ? { type: 'order-up', alone: mayGoAlone && count >= 4 && value >= 9 }
      : { type: 'pass' }
  }
  if (state.phase === 'calling') {
    if (
      state.exchangedPlayer === state.activePlayer &&
      (!state.rules.stickDealer || state.activePlayer !== state.dealer)
    ) {
      return { type: 'pass' }
    }
    const available = SUITS.filter((suit) => {
      return (
        suit !== state.upCard.suit &&
        (!state.rules.requireNaturalTrump || hasNaturalTrump(state.hands[state.activePlayer], suit))
      )
    })
    if (available.length === 0) {
      return { type: 'pass' }
    }
    const best = available
      .map((suit) => {
        return { suit, ...evaluateTrump(state.hands[state.activePlayer], suit) }
      })
      .sort((a, b) => {
        return b.value - a.value
      })[0]
    return wantsTrump(best.count, best.value) || state.activePlayer === state.dealer
      ? { type: 'call-trump', suit: best.suit, alone: best.count >= 4 && best.value >= 9 }
      : { type: 'pass' }
  }
  if (state.phase === 'playing' && state.trump !== null) {
    return { type: 'play', cardId: chooseCard(state).id }
  }
  return null
}
