import { describe, expect, it } from 'vitest'
import { chooseBotAction } from './game/bot'
import {
  createDeck,
  effectiveSuit,
  legalCards,
  shuffle,
  sortHand,
  trickWinner,
  type Card,
} from './game/card'
import { createGame } from './game/deal'
import { reduceGame } from './game/reduce'
import { DEFAULT_RULES } from './game/rules'
import type { GameState } from './game/state'

const card = (rank: Card['rank'], suit: Card['suit']): Card => {
  return {
    id: `${rank}-${suit}`,
    rank,
    suit,
  }
}

describe('Euchre rules', () => {
  it('treats the left bower as trump when following suit', () => {
    const left = card('J', 'diamonds')
    const offSuit = card('A', 'diamonds')
    const hand = [left, offSuit]
    const trick = [{ player: 1 as const, card: card('9', 'hearts') }]

    expect(effectiveSuit(left, 'hearts')).toBe('hearts')
    expect(legalCards(hand, trick, 'hearts')).toEqual([left])
  })

  it('ranks the right bower above the left bower', () => {
    const trick = [
      { player: 0 as const, card: card('A', 'hearts') },
      { player: 1 as const, card: card('J', 'diamonds') },
      { player: 2 as const, card: card('J', 'hearts') },
      { player: 3 as const, card: card('9', 'hearts') },
    ]
    expect(trickWinner(trick, 'hearts')).toBe(2)
  })

  it('groups trump at the end of the hand with the bowers highest', () => {
    const hand = [
      card('J', 'hearts'),
      card('9', 'clubs'),
      card('J', 'diamonds'),
      card('A', 'hearts'),
    ]

    expect(
      sortHand(hand, 'hearts').map(({ id }) => {
        return id
      }),
    ).toEqual(['9-clubs', 'A-hearts', 'J-diamonds', 'J-hearts'])
  })

  it('prevents reneging when the player can follow suit', () => {
    const state: GameState = {
      phase: 'playing',
      dealer: 3,
      activePlayer: 0,
      hands: [[card('9', 'clubs'), card('A', 'hearts')], [], [], []],
      kitty: [],
      upCard: card('9', 'spades'),
      trump: 'spades',
      maker: 0,
      lonePlayer: null,
      exchangedPlayer: null,
      trick: [{ player: 3, card: card('A', 'clubs') }],
      tricks: [0, 0],
      playerTricks: [0, 0, 0, 0],
      wonTricks: [[], [], [], []],
      score: [0, 0],
      handNumber: 1,
      lastTrickWinner: null,
      notice: '',
      rules: { ...DEFAULT_RULES },
    }
    expect(reduceGame(state, { type: 'play', cardId: 'A-hearts' })).toBe(state)
  })

  it('creates a complete 24-card deal', () => {
    const game = createGame(createDeck())
    expect(game.hands.flat()).toHaveLength(20)
    expect(game.kitty).toHaveLength(4)
    expect(createDeck()).toHaveLength(24)
  })

  it('shuffles without losing or duplicating cards', () => {
    const deck = createDeck()
    const shuffled = shuffle(deck)
    const shuffledIds = shuffled.map((card) => {
      return card.id
    })
    const deckIds = deck.map((card) => {
      return card.id
    })
    expect(shuffled).toHaveLength(deck.length)
    expect(new Set(shuffledIds).size).toBe(deck.length)
    expect([...shuffledIds].sort()).toEqual([...deckIds].sort())
    expect(shuffled).not.toBe(deck)
  })

  it("exchanges the first eligible farmer's hand for the face-down kitty", () => {
    const farmerCards = [card('9', 'clubs'), card('9', 'diamonds'), card('9', 'hearts')]
    const secondFarmerCards = [card('10', 'clubs'), card('10', 'diamonds'), card('10', 'hearts')]
    const reserved = [...farmerCards, ...secondFarmerCards]
    const remaining = createDeck().filter((candidate) => {
      return !reserved.some(({ id }) => {
        return id === candidate.id
      })
    })
    const hands = [
      [...farmerCards, ...remaining.splice(0, 2)],
      [...secondFarmerCards, ...remaining.splice(0, 2)],
      remaining.splice(0, 5),
      remaining.splice(0, 5),
    ]
    const deck = Array.from({ length: 5 }, (_, round) => {
      return hands.map((hand) => {
        return hand[round]
      })
    })
      .flat()
      .concat(remaining)
    const game = createGame(deck, { ...DEFAULT_RULES, allowFarmersHand: true })

    expect(game.phase).toBe('exchanging')
    expect(game.activePlayer).toBe(0)
    const faceDownKitty = game.kitty.slice(1)
    const exchanged = reduceGame(game, { type: 'exchange-kitty' })
    expect(exchanged.phase).toBe('ordering')
    expect(exchanged.activePlayer).toBe(0)
    expect(exchanged.exchangedPlayer).toBe(0)
    expect(exchanged.hands[0]).toEqual(expect.arrayContaining(faceDownKitty))
    expect(
      exchanged.hands[0].filter(({ rank }) => {
        return rank === '9'
      }),
    ).toHaveLength(0)
    expect(exchanged.kitty.slice(1)).toEqual(farmerCards)
    expect(reduceGame(exchanged, { type: 'order-up' })).toBe(exchanged)
  })

  it("requires a player who exchanged a farmer's hand to pass unless stuck as dealer", () => {
    const game = createGame(createDeck(), { ...DEFAULT_RULES, allowFarmersHand: true })
    const restricted = {
      ...game,
      phase: 'calling' as const,
      activePlayer: 0 as const,
      exchangedPlayer: 0 as const,
    }
    restricted.upCard = card('9', 'clubs')
    restricted.hands[0] = [card('A', 'hearts')]
    expect(reduceGame(restricted, { type: 'call-trump', suit: 'hearts' })).toBe(restricted)

    const stuckDealer = { ...restricted, activePlayer: 3 as const, exchangedPlayer: 3 as const }
    stuckDealer.hands[3] = [card('A', 'hearts')]
    expect(reduceGame(stuckDealer, { type: 'call-trump', suit: 'hearts' }).phase).toBe('playing')
  })

  it('does not let the dealer pass in the second bidding round', () => {
    let game = createGame(createDeck())
    for (let index = 0; index < 7; index += 1) {
      game = reduceGame(game, { type: 'pass' })
    }

    expect(game.phase).toBe('calling')
    expect(game.activePlayer).toBe(game.dealer)
    expect(reduceGame(game, { type: 'pass' })).toBe(game)
  })

  it('passes with only two weak cards in the turned-up suit', () => {
    const game = createGame(createDeck())
    game.activePlayer = 1
    game.upCard = card('9', 'hearts')
    game.hands[1] = [
      card('9', 'hearts'),
      card('10', 'hearts'),
      card('A', 'clubs'),
      card('9', 'clubs'),
      card('Q', 'diamonds'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'pass' })
  })

  it('passes with the left bower and two low trump', () => {
    const game = createGame(createDeck())
    game.activePlayer = 1
    game.dealer = 3
    game.upCard = card('9', 'hearts')
    game.hands[1] = [
      card('J', 'diamonds'),
      card('9', 'hearts'),
      card('10', 'hearts'),
      card('9', 'clubs'),
      card('Q', 'spades'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'pass' })
  })

  it('does not go alone when ordering up its partner by default', () => {
    const game = createGame(createDeck())
    game.activePlayer = 1
    game.upCard = card('9', 'hearts')
    game.hands[1] = [
      card('J', 'hearts'),
      card('J', 'diamonds'),
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('9', 'clubs'),
    ]

    expect(game.rules.allowAloneWhenOrderingPartner).toBe(false)
    expect(chooseBotAction(game)).toEqual({ type: 'order-up', alone: false })
    expect(reduceGame(game, { type: 'order-up', alone: true }).lonePlayer).toBeNull()
  })

  it('lets a human dealer at any seat choose their discard', () => {
    const game = createGame(createDeck())
    game.dealer = 1
    game.activePlayer = 2
    game.upCard = card('9', 'hearts')
    game.hands[2] = [
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('Q', 'hearts'),
      card('9', 'clubs'),
      card('10', 'clubs'),
    ]

    const ordered = reduceGame(game, { type: 'order-up' })

    expect(ordered.phase).toBe('discarding')
    expect(ordered.activePlayer).toBe(1)
    expect(ordered.hands[1]).toHaveLength(6)
  })

  it('chooses a discard for a bot dealer at any seat', () => {
    const game = createGame(createDeck())
    game.dealer = 1
    game.activePlayer = 2
    game.upCard = card('9', 'hearts')
    game.hands[2] = [
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('Q', 'hearts'),
      card('9', 'clubs'),
      card('10', 'clubs'),
    ]
    const ordered = reduceGame(game, { type: 'order-up' })
    const action = chooseBotAction(ordered)

    expect(action?.type).toBe('discard')
    expect(reduceGame(ordered, action!).hands[1]).toHaveLength(5)
  })

  it('can go alone when ordering up its partner when enabled', () => {
    let game = createGame(createDeck())
    game.activePlayer = 1
    game.upCard = card('9', 'hearts')
    game.hands[1] = [
      card('J', 'hearts'),
      card('J', 'diamonds'),
      card('A', 'hearts'),
      card('K', 'hearts'),
      card('9', 'clubs'),
    ]
    game = reduceGame(game, {
      type: 'set-rule',
      rule: 'allowAloneWhenOrderingPartner',
      enabled: true,
    })

    expect(chooseBotAction(game)).toEqual({ type: 'order-up', alone: true })
    expect(reduceGame(game, { type: 'order-up', alone: true }).lonePlayer).toBe(1)
  })

  it('does not count the left bower as natural trump when ordering', () => {
    const game = createGame(createDeck())
    game.activePlayer = 1
    game.upCard = card('9', 'hearts')
    game.hands[1] = [
      card('J', 'diamonds'),
      card('A', 'clubs'),
      card('K', 'clubs'),
      card('A', 'spades'),
      card('K', 'spades'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'pass' })
    expect(reduceGame(game, { type: 'order-up' })).toBe(game)
  })

  it('rejects a second-round call without natural trump', () => {
    const game = {
      ...createGame(createDeck()),
      phase: 'calling' as const,
      activePlayer: 1 as const,
    }
    game.upCard = card('9', 'clubs')
    game.hands[1] = [
      card('J', 'diamonds'),
      card('A', 'clubs'),
      card('K', 'clubs'),
      card('A', 'spades'),
      card('K', 'spades'),
    ]

    expect(reduceGame(game, { type: 'call-trump', suit: 'hearts' })).toBe(game)
  })

  it('uses the cheapest card that can win an opponent-led trick', () => {
    const game = {
      ...createGame(createDeck()),
      phase: 'playing' as const,
      activePlayer: 1 as const,
      trump: 'spades' as const,
    }
    game.trick = [{ player: 0, card: card('10', 'hearts') }]
    game.hands[1] = [
      card('A', 'hearts'),
      card('Q', 'hearts'),
      card('9', 'clubs'),
      card('K', 'clubs'),
      card('10', 'diamonds'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'play', cardId: 'Q-hearts' })
  })

  it('ruffs when an opponent is winning and the bot is void', () => {
    const game = {
      ...createGame(createDeck()),
      phase: 'playing' as const,
      activePlayer: 2 as const,
      trump: 'spades' as const,
    }
    game.trick = [
      { player: 0, card: card('9', 'hearts') },
      { player: 1, card: card('A', 'hearts') },
    ]
    game.hands[2] = [
      card('9', 'clubs'),
      card('9', 'spades'),
      card('Q', 'clubs'),
      card('K', 'diamonds'),
      card('10', 'diamonds'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'play', cardId: '9-spades' })
  })

  it('does not waste trump when its partner is winning', () => {
    const game = {
      ...createGame(createDeck()),
      phase: 'playing' as const,
      activePlayer: 2 as const,
      trump: 'spades' as const,
    }
    game.trick = [
      { player: 0, card: card('A', 'hearts') },
      { player: 1, card: card('K', 'hearts') },
    ]
    game.hands[2] = [
      card('9', 'spades'),
      card('9', 'clubs'),
      card('Q', 'clubs'),
      card('K', 'diamonds'),
      card('10', 'diamonds'),
    ]

    expect(chooseBotAction(game)).toEqual({ type: 'play', cardId: '9-clubs' })
  })

  it('awards two points to defenders who euchre the makers', () => {
    const state: GameState = {
      phase: 'playing',
      dealer: 3,
      activePlayer: 3,
      hands: [[], [], [], [card('J', 'clubs')]],
      kitty: [],
      upCard: card('9', 'clubs'),
      trump: 'clubs',
      maker: 0,
      lonePlayer: null,
      exchangedPlayer: null,
      trick: [
        { player: 0, card: card('A', 'hearts') },
        { player: 1, card: card('9', 'hearts') },
        { player: 2, card: card('10', 'hearts') },
      ],
      tricks: [2, 2],
      playerTricks: [1, 1, 1, 1],
      wonTricks: [[], [], [], []],
      score: [0, 0],
      handNumber: 1,
      lastTrickWinner: null,
      notice: '',
      rules: { ...DEFAULT_RULES },
    }

    const completedTrick = reduceGame(state, { type: 'play', cardId: 'J-clubs' })
    expect(completedTrick.phase).toBe('trick-complete')
    expect(completedTrick.trick).toHaveLength(4)
    expect(completedTrick.playerTricks).toEqual([1, 1, 1, 2])
    expect(completedTrick.wonTricks).toEqual([[], [], [], []])

    const result = reduceGame(completedTrick, { type: 'collect-trick' })
    expect(result.phase).toBe('hand-over')
    expect(result.score).toEqual([0, 2])
    expect(result.wonTricks[3]).toHaveLength(1)
    expect(result.wonTricks[3][0]).toHaveLength(4)
    expect(result.handResults).toHaveLength(1)
    expect(result.handResults?.[0]).toMatchObject({
      maker: 0,
      teamTricks: [2, 3],
      playerTricks: [1, 1, 1, 2],
      points: [0, 2],
    })

    const nextHand = reduceGame(result, { type: 'next-hand' })
    expect(nextHand.handResults).toEqual(result.handResults)
  })
})
