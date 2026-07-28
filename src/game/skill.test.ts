import { describe, expect, it } from 'vitest'
import { createDeck, type Card } from './card'
import { createGame } from './deal'
import {
  calculateRatingUpdates,
  playableHandStrength,
  skillRatingDelta,
  summarizeCompletedHand,
  type HandResult,
} from './skill'

describe('skill rating', () => {
  it('rewards unlikely wins more and discounts unlucky losses', () => {
    const delta = (won: boolean, dealAdvantage: number) => {
      return skillRatingDelta({
        won,
        ownRating: 1000,
        opponentRating: 1000,
        dealAdvantage,
        gamesPlayed: 20,
        performance: 0,
      })
    }

    expect(delta(true, -0.5)).toBeGreaterThan(delta(true, 0.5))
    expect(Math.abs(delta(false, -0.5))).toBeLessThan(Math.abs(delta(false, 0.5)))
  })

  it('treats bowers as substantially stronger than low off-suit cards', () => {
    const cards = (values: [Card['rank'], Card['suit']][]): Card[] => {
      return values.map(([rank, suit]) => {
        return { id: `${rank}-${suit}`, rank, suit }
      })
    }

    const bowers = playableHandStrength(
      cards([
        ['J', 'hearts'],
        ['J', 'diamonds'],
      ]),
      'hearts',
    )
    const lowCards = playableHandStrength(
      cards([
        ['9', 'clubs'],
        ['10', 'spades'],
      ]),
      'hearts',
    )

    expect(bowers).toBeGreaterThan(lowCards * 10)
  })

  it('calculates deal luck from the original hands rather than post-call hands', () => {
    const game = {
      ...createGame(createDeck()),
      maker: 0 as const,
      trump: 'clubs' as const,
    }
    const first = summarizeCompletedHand(game, 0, 1)
    const changed = summarizeCompletedHand(
      {
        ...game,
        hands: [game.hands[1], game.hands[0], game.hands[3], game.hands[2]],
      },
      0,
      1,
    )

    expect(changed.dealAdvantage).toBe(first.dealAdvantage)
    expect(changed.expectedTeamTricks).toEqual(first.expectedTeamTricks)
  })

  it('does not let a weaker second-round trump lower the performance benchmark', () => {
    const game = {
      ...createGame(createDeck()),
      maker: 0 as const,
      trump: 'clubs' as const,
      upCard: { id: 'up-9-diamonds', rank: '9' as const, suit: 'diamonds' as const },
    }
    const clubs = summarizeCompletedHand(game, 0, 1)
    const hearts = summarizeCompletedHand({ ...game, trump: 'hearts' }, 0, 1)

    expect(hearts.expectedTeamTricks).toEqual(clubs.expectedTeamTricks)
  })

  it('attributes calls, partner calls, defense, and luck-adjusted tricks separately', () => {
    const hand: HandResult = {
      handNumber: 1,
      dealer: 3,
      maker: 0,
      lonePlayer: null,
      callingRound: 1,
      teamTricks: [3, 2],
      playerTricks: [2, 1, 1, 1],
      expectedTeamTricks: [2.5, 2.5],
      expectedPlayerTricks: [1, 1.25, 1.5, 1.25],
      dealAdvantage: -0.1,
      points: [1, 0],
    }
    const updates = calculateRatingUpdates(
      ([0, 1, 2, 3] as const).map((seat) => {
        return {
          seat,
          userId: `player-${seat}`,
          rating: 1000,
          gamesPlayed: 0,
        }
      }),
      [hand],
      0,
    )

    expect(updates[0]).toMatchObject({ calls: 1, callsWon: 1, tricksWon: 2 })
    expect(updates[2]).toMatchObject({ partnerCalls: 1, partnerCallsWon: 1, tricksWon: 1 })
    expect(updates[1]).toMatchObject({ defenses: 1, defensesWon: 0 })
    expect(updates[3]).toMatchObject({ defenses: 1, defensesWon: 0 })
    expect(updates[0].expectedTricksMilli).toBe(1000)
  })

  it('does not reward taking a partner trick when team performance is unchanged', () => {
    const hand: HandResult = {
      handNumber: 1,
      dealer: 3,
      maker: 0,
      lonePlayer: null,
      callingRound: 1,
      teamTricks: [3, 2],
      playerTricks: [2, 1, 1, 1],
      expectedTeamTricks: [2.5, 2.5],
      expectedPlayerTricks: [1, 1.25, 1.5, 1.25],
      dealAdvantage: 0,
      points: [1, 0],
    }
    const seats = ([0, 1, 2, 3] as const).map((seat) => {
      return {
        seat,
        userId: `player-${seat}`,
        rating: 1000,
        gamesPlayed: 20,
      }
    })
    const original = calculateRatingUpdates(seats, [hand], 0)
    const stolen = calculateRatingUpdates(seats, [{ ...hand, playerTricks: [3, 1, 0, 1] }], 0)

    expect(stolen[0].ratingDelta).toBe(original[0].ratingDelta)
    expect(stolen[2].ratingDelta).toBe(original[2].ratingDelta)
  })
})
