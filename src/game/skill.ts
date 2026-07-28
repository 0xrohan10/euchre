import { effectiveSuit, hasNaturalTrump, sameColorSuit, SUITS, type Card, type Suit } from './card'
import { teamOf, type Player, type Team } from './player'
import type { GameState } from './state'

export const BASE_SKILL_RATING = 1000

export type RatingMode = 'competitive' | 'assisted'

export type HandResult = {
  handNumber: number
  dealer: Player
  maker: Player
  lonePlayer: Player | null
  callingRound: 1 | 2
  teamTricks: [number, number]
  playerTricks: [number, number, number, number]
  expectedTeamTricks: [number, number]
  expectedPlayerTricks: [number, number, number, number]
  dealAdvantage: number
  points: [number, number]
}

export type RatingSeat = {
  seat: Player
  userId: string | null
  rating: number
  gamesPlayed: number
}

export type PlayerRatingUpdate = {
  userId: string
  ratingDelta: number
  won: boolean
  hands: number
  calls: number
  callsWon: number
  partnerCalls: number
  partnerCallsWon: number
  defenses: number
  defensesWon: number
  tricksWon: number
  expectedTricksMilli: number
}

const OFF_SUIT_VALUES = { '9': 0.2, '10': 0.3, J: 0.5, Q: 0.7, K: 1.1, A: 2.7 } as const
const TRUMP_VALUES = { '9': 3.2, '10': 3.8, J: 0, Q: 4.5, K: 5.2, A: 6.2 } as const

export function playableHandStrength(cards: readonly Card[], trump: Suit): number {
  return cards.reduce((total, card) => {
    if (card.rank === 'J' && card.suit === trump) {
      return total + 10
    }
    if (card.rank === 'J' && card.suit === sameColorSuit(trump)) {
      return total + 9
    }
    return (
      total +
      (effectiveSuit(card, trump) === trump ? TRUMP_VALUES[card.rank] : OFF_SUIT_VALUES[card.rank])
    )
  }, 0)
}

function cardsByPlayer(state: GameState): [Card[], Card[], Card[], Card[]] {
  const cards: [Card[], Card[], Card[], Card[]] = [[], [], [], []]
  for (const tricks of state.wonTricks ?? []) {
    for (const trick of tricks) {
      for (const played of trick) {
        cards[played.player].push(played.card)
      }
    }
  }
  state.hands.forEach((hand, player) => {
    cards[player as Player].push(...hand)
  })
  return cards
}

function expectedTricks(strength0: number, strength1: number): [number, number] {
  const total = strength0 + strength1
  const team0 = total === 0 ? 2.5 : (5 * strength0) / total
  return [team0, 5 - team0]
}

function bestDealerHand(cards: readonly Card[], upCard: Card, trump: Suit): Card[] {
  const pickup = [...cards, upCard]
  return pickup.reduce<Card[]>((best, _, discarded) => {
    const candidate = pickup.filter((__, index) => {
      return index !== discarded
    })
    return playableHandStrength(candidate, trump) > playableHandStrength(best, trump)
      ? candidate
      : best
  }, pickup.slice(1))
}

function preDecisionHands(
  state: GameState,
  fallback: [Card[], Card[], Card[], Card[]],
  trump: Suit,
) {
  const hands = (state.initialHands ?? fallback).map((hand) => {
    return [...hand]
  }) as [Card[], Card[], Card[], Card[]]
  if (trump === state.upCard.suit) {
    hands[state.dealer] = bestDealerHand(hands[state.dealer], state.upCard, trump)
  }
  return hands
}

export function summarizeCompletedHand(
  state: GameState,
  scoringTeam: Team,
  scoredPoints: number,
): HandResult {
  if (state.maker === null || state.trump === null) {
    throw new Error('Cannot summarize a hand without a contract.')
  }

  const cards = cardsByPlayer(state)
  const sittingOut = state.lonePlayer === null ? null : (((state.lonePlayer + 2) % 4) as Player)
  const legalTrumps =
    state.trump === state.upCard.suit
      ? [state.upCard.suit]
      : SUITS.filter((suit) => {
          return (
            suit !== state.upCard.suit &&
            (!state.rules.requireNaturalTrump ||
              hasNaturalTrump((state.initialHands ?? cards)[state.maker!], suit))
          )
        })
  const makerTeam = teamOf(state.maker)
  const expectation = legalTrumps
    .map((trump) => {
      const expectedCards = preDecisionHands(state, cards, trump)
      const playerStrengths = expectedCards.map((hand, player) => {
        return player === sittingOut ? 0 : playableHandStrength(hand, trump)
      }) as [number, number, number, number]
      const teamStrengths: [number, number] = [
        playerStrengths[0] + playerStrengths[2],
        playerStrengths[1] + playerStrengths[3],
      ]
      return {
        playerStrengths,
        teamStrengths,
        teamTricks: expectedTricks(teamStrengths[0], teamStrengths[1]),
      }
    })
    .reduce((best, candidate) => {
      return candidate.teamTricks[makerTeam] > best.teamTricks[makerTeam] ? candidate : best
    })
  const expectedStrengths = expectation.playerStrengths
  const teamStrengths = expectation.teamStrengths
  const expectedTeam = expectation.teamTricks
  const expectedPlayer = expectedStrengths.map((strength, player) => {
    const team = teamOf(player as Player)
    return teamStrengths[team] === 0 ? 0 : (expectedTeam[team] * strength) / teamStrengths[team]
  }) as [number, number, number, number]

  const dealCards = state.initialHands ?? cards
  const bestTeamStrengths = ([0, 1] as const).map((team) => {
    return Math.max(
      ...SUITS.map((trump) => {
        return dealCards.reduce((total, hand, player) => {
          if (teamOf(player as Player) !== team) {
            return total
          }
          const playable =
            player === state.dealer && trump === state.upCard.suit
              ? bestDealerHand(hand, state.upCard, trump)
              : hand
          return total + playableHandStrength(playable, trump)
        }, 0)
      }),
    )
  }) as [number, number]
  const bestStrengthTotal = bestTeamStrengths[0] + bestTeamStrengths[1]
  const dealAdvantage =
    bestStrengthTotal === 0 ? 0 : (bestTeamStrengths[0] - bestTeamStrengths[1]) / bestStrengthTotal
  const points: [number, number] = [0, 0]
  points[scoringTeam] = scoredPoints

  return {
    handNumber: state.handNumber,
    dealer: state.dealer,
    maker: state.maker,
    lonePlayer: state.lonePlayer,
    callingRound: state.trump === state.upCard.suit ? 1 : 2,
    teamTricks: [...state.tricks],
    playerTricks: [...state.playerTricks],
    expectedTeamTricks: expectedTeam,
    expectedPlayerTricks: expectedPlayer,
    dealAdvantage,
    points,
  }
}

export function skillRatingDelta(input: {
  won: boolean
  ownRating: number
  opponentRating: number
  dealAdvantage: number
  gamesPlayed: number
  performance: number
}): number {
  const adjustedGap = input.ownRating - input.opponentRating + input.dealAdvantage * 200
  const expectedWin = 1 / (1 + 10 ** (-adjustedGap / 400))
  const kFactor = input.gamesPlayed < 10 ? 40 : 24
  return Math.round(kFactor * (Number(input.won) - expectedWin) + 16 * input.performance)
}

export function calculateRatingUpdates(
  seats: readonly RatingSeat[],
  hands: readonly HandResult[],
  winner: Team,
): PlayerRatingUpdate[] {
  const teamRatings = ([0, 1] as const).map((team) => {
    const teamSeats = seats.filter((seat) => {
      return teamOf(seat.seat) === team
    })
    return (
      teamSeats.reduce((total, seat) => {
        return total + seat.rating
      }, 0) / teamSeats.length
    )
  }) as [number, number]
  const dealAdvantage0 =
    hands.length === 0
      ? 0
      : hands.reduce((total, hand) => {
          return total + hand.dealAdvantage
        }, 0) / hands.length

  return seats.flatMap((seat) => {
    if (!seat.userId) {
      return []
    }
    const team = teamOf(seat.seat)
    let performance = 0
    let calls = 0
    let callsWon = 0
    let partnerCalls = 0
    let partnerCallsWon = 0
    let defenses = 0
    let defensesWon = 0
    let tricksWon = 0
    let expectedTricks = 0

    for (const hand of hands) {
      const sittingOut = hand.lonePlayer !== null && (hand.lonePlayer + 2) % 4 === seat.seat
      if (!sittingOut) {
        const teamResidual = (hand.teamTricks[team] - hand.expectedTeamTricks[team]) / 5
        performance += teamResidual
      }
      tricksWon += hand.playerTricks[seat.seat]
      expectedTricks += hand.expectedPlayerTricks[seat.seat]

      const makerTeam = teamOf(hand.maker)
      const makersWon = hand.teamTricks[makerTeam] >= 3
      if (hand.maker === seat.seat) {
        calls += 1
        callsWon += Number(makersWon)
      } else if (makerTeam === team) {
        partnerCalls += 1
        partnerCallsWon += Number(makersWon)
      } else {
        defenses += 1
        defensesWon += Number(!makersWon)
      }
    }

    const won = team === winner
    return [
      {
        userId: seat.userId,
        ratingDelta: skillRatingDelta({
          won,
          ownRating: teamRatings[team],
          opponentRating: teamRatings[(1 - team) as Team],
          dealAdvantage: team === 0 ? dealAdvantage0 : -dealAdvantage0,
          gamesPlayed: seat.gamesPlayed,
          performance: hands.length === 0 ? 0 : performance / hands.length,
        }),
        won,
        hands: hands.length,
        calls,
        callsWon,
        partnerCalls,
        partnerCallsWon,
        defenses,
        defensesWon,
        tricksWon,
        expectedTricksMilli: Math.round(expectedTricks * 1000),
      },
    ]
  })
}
