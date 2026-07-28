import { describe, expect, it, vi } from 'vitest'
import type { GameHistorySeat } from '../game/history'
import type { HandResult } from '../game/skill'
import {
  isValidFinalScore,
  participantsMatchHistorySeats,
  pendingEvidenceFromGame,
  persistRatingOutbox,
  reconcilePendingRatings,
  validateCompleteHandResults,
} from './rating-reconciliation.server'

function hand(overrides: Partial<HandResult> = {}): HandResult {
  return {
    handNumber: 1,
    dealer: 0,
    maker: 0,
    lonePlayer: null,
    callingRound: 1,
    teamTricks: [3, 2],
    playerTricks: [2, 1, 1, 1],
    expectedTeamTricks: [2.5, 2.5],
    expectedPlayerTricks: [1.25, 1.25, 1.25, 1.25],
    dealAdvantage: 0,
    points: [1, 0],
    ...overrides,
  }
}

describe('pendingEvidenceFromGame', () => {
  it('keeps complete final hand evidence', () => {
    const result = hand()

    expect(
      pendingEvidenceFromGame({
        handNumber: 1,
        handResults: [result],
        ratingEvidenceComplete: true,
        ratingMode: 'competitive',
        ratingParticipants: ['a', 'b', 'c', 'd'],
      }),
    ).toEqual({
      mode: 'competitive',
      participants: ['a', 'b', 'c', 'd'],
      forfeitTeam: undefined,
      handResults: [result],
    })
  })

  it('stores null when final hand evidence is incomplete', () => {
    expect(
      pendingEvidenceFromGame({
        handNumber: 2,
        handResults: [],
        ratingEvidenceComplete: true,
      }).handResults,
    ).toBeNull()
  })
})

describe('rating work evidence validation', () => {
  const seats: GameHistorySeat[] = ['a', 'b', 'c', 'd'].map((userId, seat) => {
    return { seat, userId, name: userId, controller: 'human' }
  })

  it('requires every rated participant to match the persisted seat', () => {
    expect(participantsMatchHistorySeats(['a', null, 'c', 'd'], seats)).toBe(true)
    expect(participantsMatchHistorySeats(['b', 'a', 'c', 'd'], seats)).toBe(false)
  })

  it.each([
    ['maker makes', hand(), [1, 0]],
    ['march', hand({ teamTricks: [5, 0], playerTricks: [3, 0, 2, 0], points: [2, 0] }), [2, 0]],
    [
      'lone march',
      hand({
        lonePlayer: 0,
        teamTricks: [5, 0],
        playerTricks: [5, 0, 0, 0],
        expectedPlayerTricks: [2.5, 1.25, 0, 1.25],
        points: [4, 0],
      }),
      [4, 0],
    ],
    ['euchre', hand({ teamTricks: [2, 3], playerTricks: [1, 2, 1, 1], points: [0, 2] }), [0, 2]],
  ] as const)('accepts points for a %s', (_name, result, score) => {
    expect(validateCompleteHandResults([result], 1, score)).toEqual({ handResults: [result] })
  })

  it.each([
    ['lone player is not maker', hand({ lonePlayer: 2 })],
    ['trick total is not five', hand({ teamTricks: [3, 3] })],
    ['points contradict tricks', hand({ points: [2, 0] })],
  ])('rejects evidence when %s', (_name, result) => {
    expect(validateCompleteHandResults([result], 1, result.points)).toHaveProperty('failureCode')
  })

  it('requires sequential hand numbers and rotating dealers', () => {
    const second = hand({ handNumber: 2, dealer: 0 })
    expect(validateCompleteHandResults([hand(), second], 2, [2, 0])).toEqual({
      failureCode: 'contradictory-hand-results',
    })
    expect(
      validateCompleteHandResults([hand(), hand({ handNumber: 3, dealer: 1 })], 2, [2, 0]),
    ).toEqual({
      failureCode: 'invalid-hand-results',
    })
  })

  it('requires aggregate hand points to equal persisted final score', () => {
    expect(validateCompleteHandResults([hand()], 1, [10, 7])).toEqual({
      failureCode: 'contradictory-hand-results',
    })
  })

  it.each([
    ['a score above the maximum final hand overshoot', [14, 0]],
    ['a score below the winning threshold', [1, 0]],
  ] as const)('rejects %s', (_name, finalScore) => {
    expect(isValidFinalScore(finalScore[0], finalScore[1])).toBe(false)
  })

  it('rejects complete evidence that continues after a team wins', () => {
    const results = Array.from({ length: 6 }, (_, index) => {
      return hand({
        handNumber: index + 1,
        dealer: (index % 4) as 0 | 1 | 2 | 3,
        teamTricks: index === 5 ? [2, 3] : [5, 0],
        playerTricks: index === 5 ? [1, 2, 1, 1] : [3, 0, 2, 0],
        points: index === 5 ? [0, 2] : [2, 0],
      })
    })

    expect(validateCompleteHandResults(results, results.length, [10, 2])).toEqual({
      failureCode: 'contradictory-hand-results',
    })
  })
})

describe('rating pipeline error boundaries', () => {
  it('replaces outbox database errors with a fixed error', async () => {
    const database = {
      execute: vi.fn().mockRejectedValue(new Error('SQL participant-secret hand-evidence-secret')),
    }
    await expect(
      persistRatingOutbox(database as never, crypto.randomUUID(), {
        mode: 'competitive',
        participants: ['participant-secret', null, null, null],
        forfeitTeam: undefined,
        handResults: [hand()],
      }),
    ).rejects.toThrow('Rating outbox persistence failed.')
  })

  it('replaces reconciliation database errors with a fixed error', async () => {
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error('Drizzle query params participant-secret')),
    }
    await expect(reconcilePendingRatings(database as never, 1)).rejects.toThrow(
      'Rating reconciliation failed.',
    )
  })
})
