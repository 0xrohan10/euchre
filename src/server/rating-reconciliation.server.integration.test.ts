import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import {
  gameHistory,
  pendingRating,
  playerRating,
  ratedMatch,
  ratingOutbox,
  user,
} from '../db/schema'
import { DEFAULT_RULES } from '../game/rules'
import type { HandResult } from '../game/skill'
import { persistRatingOutbox, reconcilePendingRatings } from './rating-reconciliation.server'

const describeIntegration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip

describeIntegration('rating reconciliation', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
  const db = drizzle({ client: pool })
  const userIds: string[] = []
  const historyIds: string[] = []
  let workSequence = 0

  beforeAll(async () => {
    await pool.query('truncate table rating_outbox, pending_rating, rated_match, player_rating')
  })

  const handResults: HandResult[] = Array.from({ length: 5 }, (_, index) => {
    return {
      handNumber: index + 1,
      dealer: (index % 4) as 0 | 1 | 2 | 3,
      maker: 0,
      lonePlayer: null,
      callingRound: 1,
      teamTricks: [5, 0],
      playerTricks: [3, 0, 2, 0],
      expectedTeamTricks: [2.5, 2.5],
      expectedPlayerTricks: [1.25, 1.25, 1.25, 1.25],
      dealAdvantage: 0,
      points: [2, 0],
    }
  })

  afterEach(async () => {
    for (const historyId of historyIds.splice(0)) {
      await pool.query('delete from game_history where id = $1', [historyId])
    }
    for (const userId of userIds.splice(0)) {
      await pool.query('delete from "user" where id = $1', [userId])
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createPlayers() {
    return Promise.all(
      ['a', 'b', 'c', 'd'].map(async (label) => {
        const id = `rating-int-${label}-${crypto.randomUUID()}`
        userIds.push(id)
        await db.insert(user).values({
          id,
          name: label,
          email: `${id}@example.test`,
          emailVerified: true,
        })
        return id
      }),
    ) as Promise<[string, string, string, string]>
  }

  function historyValues(historyId: string, players: [string, string, string, string]) {
    return {
      id: historyId,
      sourceRoomId: crypto.randomUUID(),
      sourceMatchId: crypto.randomUUID(),
      score0: 10,
      score1: 0,
      handCount: handResults.length,
      rules: DEFAULT_RULES,
      seats: players.map((userId, seat) => {
        return {
          seat,
          userId,
          name: userId,
          controller: 'human' as const,
        }
      }),
    }
  }

  async function createWork(
    source: 'legacy' | 'v2',
    players: [string, string, string, string],
    createdAt = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, workSequence++)),
  ) {
    const historyId = crypto.randomUUID()
    historyIds.push(historyId)
    if (source === 'v2') {
      await db.transaction(async (tx) => {
        await tx.insert(gameHistory).values(historyValues(historyId, players))
        await persistRatingOutbox(tx, historyId, {
          mode: 'competitive',
          participants: players,
          forfeitTeam: undefined,
          handResults,
        })
        await tx
          .update(ratingOutbox)
          .set({ createdAt })
          .where(eq(ratingOutbox.gameHistoryId, historyId))
      })
    } else {
      await db.insert(gameHistory).values(historyValues(historyId, players))
      await db
        .update(pendingRating)
        .set({
          createdAt,
          mode: 'competitive',
          participants: players,
          handResults: null,
        })
        .where(eq(pendingRating.gameHistoryId, historyId))
    }
    return historyId
  }

  it('moves trigger work to v2 before commit so legacy workers cannot see it', async () => {
    const players = await createPlayers()
    const historyId = crypto.randomUUID()
    historyIds.push(historyId)

    await db.transaction(async (tx) => {
      await tx.insert(gameHistory).values(historyValues(historyId, players))
      const triggerRows = await tx
        .select()
        .from(pendingRating)
        .where(eq(pendingRating.gameHistoryId, historyId))
      expect(triggerRows).toHaveLength(1)

      await persistRatingOutbox(tx, historyId, {
        mode: 'competitive',
        participants: players,
        forfeitTeam: undefined,
        handResults,
      })
      const movedLegacyRows = await tx
        .select()
        .from(pendingRating)
        .where(eq(pendingRating.gameHistoryId, historyId))
      expect(movedLegacyRows).toHaveLength(0)
    })

    const legacyVisible = await db
      .select()
      .from(pendingRating)
      .where(eq(pendingRating.gameHistoryId, historyId))
    const [v2] = await db
      .select()
      .from(ratingOutbox)
      .where(eq(ratingOutbox.gameHistoryId, historyId))
    expect(legacyVisible).toHaveLength(0)
    expect(v2.handResults).toEqual(handResults)
    expect(v2.participants).toEqual(players)
  })

  it('never replaces complete v2 evidence with a later incomplete update', async () => {
    const players = await createPlayers()
    const historyId = await createWork('v2', players)

    await db.transaction(async (tx) => {
      await persistRatingOutbox(tx, historyId, {
        mode: 'assisted',
        participants: [...players].reverse() as [string, string, string, string],
        forfeitTeam: 1,
        handResults: null,
      })
    })

    const [outbox] = await db
      .select()
      .from(ratingOutbox)
      .where(eq(ratingOutbox.gameHistoryId, historyId))
    expect(outbox.mode).toBe('competitive')
    expect(outbox.participants).toEqual(players)
    expect(outbox.forfeitTeam).toBeNull()
    expect(outbox.handResults).toEqual(handResults)
  })

  it('recovers a legacy trigger row with legacy defaults', async () => {
    const players = await createPlayers()
    const historyId = crypto.randomUUID()
    historyIds.push(historyId)
    await db.insert(gameHistory).values(historyValues(historyId, players))
    await db
      .update(pendingRating)
      .set({ createdAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(pendingRating.gameHistoryId, historyId))

    await reconcilePendingRatings(db, 1)

    const ratings = await db
      .select({ gamesPlayed: playerRating.gamesPlayed, mode: playerRating.mode })
      .from(playerRating)
      .where(eq(playerRating.userId, players[0]))
    const legacy = await db
      .select()
      .from(pendingRating)
      .where(eq(pendingRating.gameHistoryId, historyId))
    expect(ratings).toEqual([{ gamesPlayed: 1, mode: 'assisted' }])
    expect(legacy).toHaveLength(0)
  })

  it('redirects an old Worker claim and preserves global order for the v2 consumer', async () => {
    const players = await createPlayers()
    const oldestV2 = await createWork('v2', players, new Date('2026-01-01T00:00:00.000Z'))
    const legacy = await createWork('legacy', players, new Date('2026-01-02T00:00:00.000Z'))

    const oldClaims = await pool.query(
      'insert into rated_match (game_history_id) values ($1) on conflict do nothing returning game_history_id',
      [legacy],
    )

    expect(oldClaims.rows).toHaveLength(0)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, legacy)),
    ).toHaveLength(0)
    expect(
      await db.select().from(pendingRating).where(eq(pendingRating.gameHistoryId, legacy)),
    ).toHaveLength(0)
    expect(
      await db.select().from(ratingOutbox).where(eq(ratingOutbox.gameHistoryId, legacy)),
    ).toHaveLength(1)

    expect(await reconcilePendingRatings(db, 1)).toBe(1)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, oldestV2)),
    ).toHaveLength(1)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, legacy)),
    ).toHaveLength(0)

    expect(await reconcilePendingRatings(db, 1)).toBe(1)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, legacy)),
    ).toHaveLength(1)
  })

  it('suppresses a stale old Worker claim after new code has moved its legacy row', async () => {
    const players = await createPlayers()
    const historyId = await createWork('legacy', players)
    await db.transaction(async (tx) => {
      await persistRatingOutbox(tx, historyId, {
        mode: 'competitive',
        participants: players,
        forfeitTeam: undefined,
        handResults,
      })
    })

    const oldClaims = await pool.query(
      'insert into rated_match (game_history_id) values ($1) on conflict do nothing returning game_history_id',
      [historyId],
    )

    expect(oldClaims.rows).toHaveLength(0)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, historyId)),
    ).toHaveLength(0)
    expect(await reconcilePendingRatings(db, 1)).toBe(1)
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, historyId)),
    ).toHaveLength(1)
  })

  it('quarantines every malformed evidence class and continues to newer work', async () => {
    const players = await createPlayers()
    const poison = await Promise.all(
      Array.from({ length: 4 }, () => {
        return createWork('v2', players)
      }),
    )
    const valid = await createWork('v2', players)
    await pool.query('update rating_outbox set mode = $2 where game_history_id = $1', [
      poison[0],
      'unknown',
    ])
    await pool.query(
      'update rating_outbox set participants = $2::jsonb where game_history_id = $1',
      [poison[1], JSON.stringify([players[0], players[0], null, null])],
    )
    await pool.query('update rating_outbox set forfeit_team = 3 where game_history_id = $1', [
      poison[2],
    ])
    await pool.query(
      'update rating_outbox set hand_results = $2::jsonb where game_history_id = $1',
      [poison[3], JSON.stringify([{ ...handResults[0], dealer: 9 }])],
    )
    for (const [index, historyId] of [...poison, valid].entries()) {
      await db
        .update(ratingOutbox)
        .set({ createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`) })
        .where(eq(ratingOutbox.gameHistoryId, historyId))
    }

    expect(await reconcilePendingRatings(db, 5)).toBe(5)

    const failures = await db
      .select({
        gameHistoryId: ratingOutbox.gameHistoryId,
        failedAt: ratingOutbox.failedAt,
        failureCode: ratingOutbox.failureCode,
      })
      .from(ratingOutbox)
      .where(inArray(ratingOutbox.gameHistoryId, poison))
    expect(failures).toHaveLength(4)
    expect(
      failures
        .map(({ failureCode }) => {
          return failureCode
        })
        .sort(),
    ).toEqual([
      'invalid-forfeit-team',
      'invalid-hand-results',
      'invalid-mode',
      'invalid-participants',
    ])
    expect(
      failures.every(({ failedAt }) => {
        return failedAt instanceof Date
      }),
    ).toBe(true)
    const validClaim = await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, valid))
    expect(validClaim).toHaveLength(1)
  })

  it('quarantines participant and hand contradictions before claiming, then continues', async () => {
    const players = await createPlayers()
    const participantMismatch = await createWork('v2', players)
    const contradictoryHands = await createWork('v2', players)
    const valid = await createWork('v2', players)
    await db
      .update(ratingOutbox)
      .set({ participants: [players[1], players[0], players[2], players[3]] })
      .where(eq(ratingOutbox.gameHistoryId, participantMismatch))
    await db
      .update(ratingOutbox)
      .set({ handResults: [{ ...handResults[0], points: [1, 0] }, ...handResults.slice(1)] })
      .where(eq(ratingOutbox.gameHistoryId, contradictoryHands))
    for (const [index, historyId] of [participantMismatch, contradictoryHands, valid].entries()) {
      await db
        .update(ratingOutbox)
        .set({ createdAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`) })
        .where(eq(ratingOutbox.gameHistoryId, historyId))
    }

    expect(await reconcilePendingRatings(db, 3)).toBe(3)

    const quarantined = await db
      .select({ gameHistoryId: ratingOutbox.gameHistoryId, failureCode: ratingOutbox.failureCode })
      .from(ratingOutbox)
    expect(quarantined).toEqual(
      expect.arrayContaining([
        { gameHistoryId: participantMismatch, failureCode: 'participant-seat-mismatch' },
        { gameHistoryId: contradictoryHands, failureCode: 'contradictory-hand-results' },
      ]),
    )
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, valid)),
    ).toHaveLength(1)
    expect(
      await db
        .select({ gamesPlayed: playerRating.gamesPlayed })
        .from(playerRating)
        .where(eq(playerRating.userId, players[0])),
    ).toEqual([{ gamesPlayed: 1 }])
  })

  it('quarantines impossible final scores and early-win continuation before claiming', async () => {
    const players = await createPlayers()
    const scoreAboveMaximum = await createWork('v2', players)
    const scoreBelowWinning = await createWork('v2', players)
    const earlyWinContinuation = await createWork('v2', players)
    const valid = await createWork('v2', players)
    const continuedHands = [
      ...handResults,
      {
        ...handResults[0],
        handNumber: 6,
        dealer: 1 as const,
        teamTricks: [2, 3] as [number, number],
        playerTricks: [1, 2, 1, 1] as [number, number, number, number],
        points: [0, 2] as [number, number],
      },
    ]
    await db
      .update(gameHistory)
      .set({ score0: 14, score1: 0 })
      .where(eq(gameHistory.id, scoreAboveMaximum))
    await db
      .update(gameHistory)
      .set({ score0: 1, score1: 0 })
      .where(eq(gameHistory.id, scoreBelowWinning))
    await db
      .update(gameHistory)
      .set({ score0: 10, score1: 2, handCount: continuedHands.length })
      .where(eq(gameHistory.id, earlyWinContinuation))
    await db
      .update(ratingOutbox)
      .set({ handResults: continuedHands })
      .where(eq(ratingOutbox.gameHistoryId, earlyWinContinuation))
    for (const [index, historyId] of [
      scoreAboveMaximum,
      scoreBelowWinning,
      earlyWinContinuation,
      valid,
    ].entries()) {
      await db
        .update(ratingOutbox)
        .set({ createdAt: new Date(`2026-03-0${index + 1}T00:00:00.000Z`) })
        .where(eq(ratingOutbox.gameHistoryId, historyId))
    }

    expect(await reconcilePendingRatings(db, 4)).toBe(4)

    const quarantined = await db
      .select({ gameHistoryId: ratingOutbox.gameHistoryId, failureCode: ratingOutbox.failureCode })
      .from(ratingOutbox)
    expect(quarantined).toEqual(
      expect.arrayContaining([
        { gameHistoryId: scoreAboveMaximum, failureCode: 'invalid-score' },
        { gameHistoryId: scoreBelowWinning, failureCode: 'invalid-score' },
        { gameHistoryId: earlyWinContinuation, failureCode: 'contradictory-hand-results' },
      ]),
    )
    expect(
      await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, valid)),
    ).toHaveLength(1)
    for (const historyId of [scoreAboveMaximum, scoreBelowWinning, earlyWinContinuation]) {
      expect(
        await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, historyId)),
      ).toHaveLength(0)
    }
  })

  it('does not apply duplicate delivery twice', async () => {
    const players = await createPlayers()
    const historyId = await createWork('v2', players)

    await reconcilePendingRatings(db, 2)
    await reconcilePendingRatings(db, 1)

    const ratings = await db
      .select({ gamesPlayed: playerRating.gamesPlayed })
      .from(playerRating)
      .where(eq(playerRating.userId, players[0]))
    const claims = await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, historyId))
    expect(ratings).toEqual([{ gamesPlayed: 1 }])
    expect(claims).toHaveLength(1)
  })

  it('serializes concurrent consumers and rates once', async () => {
    const players = await createPlayers()
    const historyId = await createWork('v2', players)

    await Promise.all([reconcilePendingRatings(db, 1), reconcilePendingRatings(db, 1)])

    const ratings = await db
      .select({ gamesPlayed: playerRating.gamesPlayed })
      .from(playerRating)
      .where(eq(playerRating.userId, players[0]))
    const remaining = await db
      .select()
      .from(ratingOutbox)
      .where(eq(ratingOutbox.gameHistoryId, historyId))
    expect(ratings).toEqual([{ gamesPlayed: 1 }])
    expect(remaining).toHaveLength(0)
  })

  it('processes the globally oldest row when legacy is older than v2', async () => {
    const players = await createPlayers()
    const legacy = await createWork('legacy', players, new Date('2026-01-01T00:00:00.000Z'))
    const v2 = await createWork('v2', players, new Date('2026-01-02T00:00:00.000Z'))

    await reconcilePendingRatings(db, 1)

    const legacyClaim = await db
      .select()
      .from(ratedMatch)
      .where(eq(ratedMatch.gameHistoryId, legacy))
    const v2Pending = await db.select().from(ratingOutbox).where(eq(ratingOutbox.gameHistoryId, v2))
    expect(legacyClaim).toHaveLength(1)
    expect(v2Pending).toHaveLength(1)
  })

  it('processes the globally oldest row when v2 is older than legacy', async () => {
    const players = await createPlayers()
    const v2 = await createWork('v2', players, new Date('2026-01-01T00:00:00.000Z'))
    const legacy = await createWork('legacy', players, new Date('2026-01-02T00:00:00.000Z'))

    await reconcilePendingRatings(db, 1)

    const v2Claim = await db.select().from(ratedMatch).where(eq(ratedMatch.gameHistoryId, v2))
    const legacyPending = await db
      .select()
      .from(pendingRating)
      .where(
        and(
          eq(pendingRating.gameHistoryId, legacy),
          eq(pendingRating.createdAt, new Date('2026-01-02T00:00:00.000Z')),
        ),
      )
    expect(v2Claim).toHaveLength(1)
    expect(legacyPending).toHaveLength(1)
  })
})
