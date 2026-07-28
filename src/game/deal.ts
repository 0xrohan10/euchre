import { type Card, type Rank, createDeck, shuffle } from './card'
import { type Player, next } from './player'
import { type GameRules, DEFAULT_RULES } from './rules'
import { emptyWonTricks, type GameState } from './state'

type MatchEvidence = Pick<
  GameState,
  | 'handResults'
  | 'ratingEvidenceComplete'
  | 'ratingMode'
  | 'ratingParticipants'
  | 'ratingForfeitTeam'
  | 'ratingBotSeats'
>

export function farmersHandRank(hand: readonly Card[]): Extract<Rank, '9' | '10'> | null {
  if (
    hand.filter((card) => {
      return card.rank === '9'
    }).length === 3
  ) {
    return '9'
  }
  if (
    hand.filter((card) => {
      return card.rank === '10'
    }).length === 3
  ) {
    return '10'
  }
  return null
}

export function deal(
  dealer: Player,
  score: [number, number],
  handNumber: number,
  rules: GameRules,
  deck = shuffle(createDeck()),
  matchEvidence: MatchEvidence = {
    handResults: [],
    ratingEvidenceComplete: true,
  },
): GameState {
  if (deck.length !== 24) {
    throw new Error('A Euchre deck must contain exactly 24 cards.')
  }
  const hands: [Card[], Card[], Card[], Card[]] = [[], [], [], []]
  let cursor = 0

  for (let round = 0; round < 5; round += 1) {
    for (let offset = 1; offset <= 4; offset += 1) {
      const player = ((dealer + offset) % 4) as Player
      hands[player].push(deck[cursor++])
    }
  }

  const kitty = deck.slice(cursor)
  const upCard = kitty[0]
  const firstBidder = next(dealer)
  const exchangingPlayer = rules.allowFarmersHand
    ? (([0, 1, 2, 3] as const)
        .map((offset) => {
          return ((firstBidder + offset) % 4) as Player
        })
        .find((player) => {
          return farmersHandRank(hands[player]) !== null
        }) ?? null)
    : null

  return {
    phase: exchangingPlayer === null ? 'ordering' : 'exchanging',
    dealer,
    activePlayer: exchangingPlayer ?? firstBidder,
    hands,
    initialHands: hands.map((hand) => {
      return [...hand]
    }) as GameState['hands'],
    kitty,
    upCard,
    trump: null,
    maker: null,
    lonePlayer: null,
    exchangedPlayer: null,
    trick: [],
    tricks: [0, 0],
    playerTricks: [0, 0, 0, 0],
    wonTricks: emptyWonTricks(),
    score,
    handNumber,
    lastTrickWinner: null,
    notice:
      exchangingPlayer === null
        ? `${upCard.rank} of ${upCard.suit} is turned up.`
        : `Player ${exchangingPlayer + 1} may exchange a farmer's hand.`,
    rules: { ...rules },
    ...matchEvidence,
  }
}

export function createGame(deck?: Card[], rules: GameRules = DEFAULT_RULES): GameState {
  return deal(3, [0, 0], 1, rules, deck)
}
