import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/index.server'
import {
  gameHistory,
  pendingRating,
  playerRating,
  ratedMatch,
  ratingOutbox,
  user,
} from '../db/schema'
import type { GameHistorySeat } from '../game/history'
import type { Player, Team } from '../game/player'
import { scoreCompletedHand } from '../game/scoring'
import {
  BASE_SKILL_RATING,
  calculateRatingUpdates,
  type HandResult,
  type RatingMode,
  type RatingSeat,
} from '../game/skill'
import type { GameState } from '../game/state'

export type RatingQueueMessage = { gameHistoryId: string }

export type PendingRatingEvidence = {
  mode: RatingMode
  participants: NonNullable<GameState['ratingParticipants']>
  forfeitTeam: GameState['ratingForfeitTeam']
  handResults: HandResult[] | null
}

type WorkSource = 'legacy' | 'v2'
type RatingWork = {
  source: WorkSource
  gameHistoryId: string
  createdAt: Date
  mode: unknown
  participants: unknown
  forfeitTeam: unknown
  handResults: unknown
  score0: number
  score1: number
  handCount: number
  seats: GameHistorySeat[]
}
type ValidRatingWork = Omit<RatingWork, 'forfeitTeam' | 'handResults' | 'mode' | 'participants'> & {
  mode: RatingMode
  participants: NonNullable<GameState['ratingParticipants']>
  forfeitTeam: Team | null
  handResults: HandResult[] | null
}

const RATING_RECONCILIATION_LOCK_ID = 1_163_218_772
const EMPTY_PARTICIPANTS: NonNullable<GameState['ratingParticipants']> = [null, null, null, null]

export async function persistRatingOutbox(
  database: Pick<Database, 'delete' | 'execute' | 'insert' | 'select'>,
  gameHistoryId: string,
  evidence: PendingRatingEvidence,
) {
  try {
    await database.execute(sql`select pg_advisory_xact_lock(${RATING_RECONCILIATION_LOCK_ID})`)
    const [legacy] = await database
      .select({ createdAt: pendingRating.createdAt })
      .from(pendingRating)
      .where(eq(pendingRating.gameHistoryId, gameHistoryId))
      .limit(1)
    await database
      .insert(ratingOutbox)
      .values({
        gameHistoryId,
        ...evidence,
        createdAt: legacy?.createdAt ?? sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: ratingOutbox.gameHistoryId,
        set: {
          mode: sql`case when ${ratingOutbox.handResults} is not null or ${ratingOutbox.failedAt} is not null then ${ratingOutbox.mode} else excluded.mode end`,
          participants: sql`case when ${ratingOutbox.handResults} is not null or ${ratingOutbox.failedAt} is not null then ${ratingOutbox.participants} else excluded.participants end`,
          forfeitTeam: sql`case when ${ratingOutbox.handResults} is not null or ${ratingOutbox.failedAt} is not null then ${ratingOutbox.forfeitTeam} else excluded.forfeit_team end`,
          handResults: sql`coalesce(${ratingOutbox.handResults}, excluded.hand_results)`,
        },
      })
    await database.delete(pendingRating).where(eq(pendingRating.gameHistoryId, gameHistoryId))
  } catch {
    throw new Error('Rating outbox persistence failed.')
  }
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function isFiniteBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function isTuple(
  value: unknown,
  length: number,
  item: (value: unknown) => boolean,
): value is unknown[] {
  return Array.isArray(value) && value.length === length && value.every(item)
}

function isValidHandResult(value: unknown, handNumber: number): value is HandResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const hand = value as Record<string, unknown>
  if (
    hand.handNumber !== handNumber ||
    !isIntegerBetween(hand.dealer, 0, 3) ||
    !isIntegerBetween(hand.maker, 0, 3) ||
    !(hand.lonePlayer === null || isIntegerBetween(hand.lonePlayer, 0, 3)) ||
    !(hand.callingRound === 1 || hand.callingRound === 2) ||
    !isTuple(hand.teamTricks, 2, (item) => {
      return isIntegerBetween(item, 0, 5)
    }) ||
    !isTuple(hand.playerTricks, 4, (item) => {
      return isIntegerBetween(item, 0, 5)
    }) ||
    !isTuple(hand.expectedTeamTricks, 2, (item) => {
      return isFiniteBetween(item, 0, 5)
    }) ||
    !isTuple(hand.expectedPlayerTricks, 4, (item) => {
      return isFiniteBetween(item, 0, 5)
    }) ||
    !isFiniteBetween(hand.dealAdvantage, -1, 1) ||
    !isTuple(hand.points, 2, (item) => {
      return isIntegerBetween(item, 0, 4)
    })
  ) {
    return false
  }

  const teamTricks = hand.teamTricks as number[]
  const playerTricks = hand.playerTricks as number[]
  const expectedTeamTricks = hand.expectedTeamTricks as number[]
  const expectedPlayerTricks = hand.expectedPlayerTricks as number[]
  const points = hand.points as number[]
  return (
    teamTricks[0] + teamTricks[1] === 5 &&
    playerTricks.reduce((sum, tricks) => {
      return sum + tricks
    }, 0) === 5 &&
    playerTricks[0] + playerTricks[2] === teamTricks[0] &&
    playerTricks[1] + playerTricks[3] === teamTricks[1] &&
    Math.abs(expectedTeamTricks[0] + expectedTeamTricks[1] - 5) < 0.001 &&
    Math.abs(expectedPlayerTricks[0] + expectedPlayerTricks[2] - expectedTeamTricks[0]) < 0.001 &&
    Math.abs(expectedPlayerTricks[1] + expectedPlayerTricks[3] - expectedTeamTricks[1]) < 0.001 &&
    points[0] + points[1] >= 1 &&
    (points[0] === 0 || points[1] === 0)
  )
}

function legacyParticipants(seats: GameHistorySeat[]): unknown {
  if (!Array.isArray(seats) || seats.length !== 4) {
    return null
  }
  const participants = [...EMPTY_PARTICIPANTS]
  const seenSeats = new Set<number>()
  for (const seat of seats) {
    if (
      typeof seat !== 'object' ||
      seat === null ||
      !isIntegerBetween(seat.seat, 0, 3) ||
      !(seat.userId === null || typeof seat.userId === 'string') ||
      seenSeats.has(seat.seat)
    ) {
      return null
    }
    seenSeats.add(seat.seat)
    participants[seat.seat] = seat.userId
  }
  return participants
}

export function participantsMatchHistorySeats(
  participants: readonly (string | null)[],
  seats: GameHistorySeat[],
): boolean {
  const historyParticipants = legacyParticipants(seats)
  return (
    Array.isArray(historyParticipants) &&
    participants.every((participant, seat) => {
      return participant === null || participant === historyParticipants[seat]
    })
  )
}

export function validateCompleteHandResults(
  value: unknown,
  handCount: number,
  finalScore: readonly [number, number],
): { handResults: HandResult[] } | { failureCode: string } {
  if (!Array.isArray(value) || value.length !== handCount) {
    return { failureCode: 'invalid-hand-results' }
  }

  const aggregatePoints: [number, number] = [0, 0]
  for (const [index, valueHand] of value.entries()) {
    if (!isValidHandResult(valueHand, index + 1)) {
      return { failureCode: 'invalid-hand-results' }
    }
    const hand = valueHand as HandResult
    const prior = value[index - 1] as HandResult | undefined
    const lonePartner = hand.lonePlayer === null ? null : (hand.lonePlayer + 2) % 4
    const expected = scoreCompletedHand(hand.maker, hand.lonePlayer, hand.teamTricks)
    const expectedPoints: [number, number] = [0, 0]
    expectedPoints[expected.scoringTeam] = expected.points
    if (
      (hand.lonePlayer !== null && hand.lonePlayer !== hand.maker) ||
      (prior !== undefined && hand.dealer !== (prior.dealer + 1) % 4) ||
      (lonePartner !== null &&
        (hand.playerTricks[lonePartner] !== 0 || hand.expectedPlayerTricks[lonePartner] !== 0)) ||
      hand.points[0] !== expectedPoints[0] ||
      hand.points[1] !== expectedPoints[1]
    ) {
      return { failureCode: 'contradictory-hand-results' }
    }
    aggregatePoints[0] += hand.points[0]
    aggregatePoints[1] += hand.points[1]
    if (index < value.length - 1 && (aggregatePoints[0] >= 10 || aggregatePoints[1] >= 10)) {
      return { failureCode: 'contradictory-hand-results' }
    }
  }

  return aggregatePoints[0] === finalScore[0] && aggregatePoints[1] === finalScore[1]
    ? { handResults: value as HandResult[] }
    : { failureCode: 'contradictory-hand-results' }
}

export function isValidFinalScore(score0: unknown, score1: unknown): boolean {
  return (
    (isIntegerBetween(score0, 10, 13) && isIntegerBetween(score1, 0, 9)) ||
    (isIntegerBetween(score1, 10, 13) && isIntegerBetween(score0, 0, 9))
  )
}

function validateRatingWork(work: RatingWork): { work: ValidRatingWork } | { failureCode: string } {
  const mode = work.source === 'legacy' && work.mode === null ? 'assisted' : work.mode
  if (mode !== 'competitive' && mode !== 'assisted') {
    return { failureCode: 'invalid-mode' }
  }

  const participants =
    work.source === 'legacy' && work.participants === null
      ? legacyParticipants(work.seats)
      : work.participants
  if (
    !isTuple(participants, 4, (participant) => {
      return participant === null || typeof participant === 'string'
    }) ||
    new Set(
      participants.filter((participant) => {
        return participant !== null
      }),
    ).size !==
      participants.filter((participant) => {
        return participant !== null
      }).length
  ) {
    return { failureCode: 'invalid-participants' }
  }
  const validParticipants = participants as NonNullable<GameState['ratingParticipants']>
  if (!participantsMatchHistorySeats(validParticipants, work.seats)) {
    return { failureCode: 'participant-seat-mismatch' }
  }

  if (!(work.forfeitTeam === null || work.forfeitTeam === 0 || work.forfeitTeam === 1)) {
    return { failureCode: 'invalid-forfeit-team' }
  }
  if (!isValidFinalScore(work.score0, work.score1)) {
    return { failureCode: 'invalid-score' }
  }
  let handResults: HandResult[] | null = null
  if (work.handResults !== null) {
    const handValidation = validateCompleteHandResults(work.handResults, work.handCount, [
      work.score0,
      work.score1,
    ])
    if ('failureCode' in handValidation) {
      return handValidation
    }
    handResults = handValidation.handResults
  }

  return {
    work: {
      ...work,
      mode,
      participants: validParticipants,
      forfeitTeam: work.forfeitTeam as Team | null,
      handResults,
    },
  }
}

function compareWork(left: RatingWork, right: RatingWork): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.gameHistoryId.localeCompare(right.gameHistoryId) ||
    left.source.localeCompare(right.source)
  )
}

async function selectOldestWork(tx: Parameters<Parameters<Database['transaction']>[0]>[0]) {
  const selectFields = {
    gameHistoryId: gameHistory.id,
    score0: gameHistory.score0,
    score1: gameHistory.score1,
    handCount: gameHistory.handCount,
    seats: gameHistory.seats,
  }
  const [v2] = await tx
    .select({
      ...selectFields,
      createdAt: ratingOutbox.createdAt,
      mode: ratingOutbox.mode,
      participants: ratingOutbox.participants,
      forfeitTeam: ratingOutbox.forfeitTeam,
      handResults: ratingOutbox.handResults,
    })
    .from(ratingOutbox)
    .innerJoin(gameHistory, eq(ratingOutbox.gameHistoryId, gameHistory.id))
    .where(isNull(ratingOutbox.failedAt))
    .orderBy(ratingOutbox.createdAt, ratingOutbox.gameHistoryId)
    .limit(1)
  const [legacy] = await tx
    .select({
      ...selectFields,
      createdAt: pendingRating.createdAt,
      mode: pendingRating.mode,
      participants: pendingRating.participants,
      forfeitTeam: pendingRating.forfeitTeam,
      handResults: pendingRating.handResults,
    })
    .from(pendingRating)
    .innerJoin(gameHistory, eq(pendingRating.gameHistoryId, gameHistory.id))
    .orderBy(pendingRating.createdAt, pendingRating.gameHistoryId)
    .limit(1)
  const candidates: RatingWork[] = []
  if (v2) {
    candidates.push({ ...v2, source: 'v2' })
  }
  if (legacy) {
    candidates.push({ ...legacy, source: 'legacy' })
  }
  return candidates.sort(compareWork)[0]
}

async function deleteWork(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  work: Pick<RatingWork, 'gameHistoryId' | 'source'>,
) {
  if (work.source === 'v2') {
    await tx.delete(ratingOutbox).where(eq(ratingOutbox.gameHistoryId, work.gameHistoryId))
  } else {
    await tx.delete(pendingRating).where(eq(pendingRating.gameHistoryId, work.gameHistoryId))
  }
}

async function quarantineWork(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  work: RatingWork,
  failureCode: string,
) {
  if (work.source === 'v2') {
    await tx
      .update(ratingOutbox)
      .set({ failedAt: new Date(), failureCode })
      .where(eq(ratingOutbox.gameHistoryId, work.gameHistoryId))
    return
  }

  await tx
    .insert(ratingOutbox)
    .values({
      gameHistoryId: work.gameHistoryId,
      createdAt: work.createdAt,
      mode:
        work.mode === 'competitive' || work.mode === 'assisted' ? work.mode : ('assisted' as const),
      participants: ((Array.isArray(work.participants)
        ? work.participants
        : legacyParticipants(work.seats)) ?? EMPTY_PARTICIPANTS) as NonNullable<
        GameState['ratingParticipants']
      >,
      forfeitTeam: work.forfeitTeam === 0 || work.forfeitTeam === 1 ? work.forfeitTeam : null,
      handResults: Array.isArray(work.handResults) ? work.handResults : null,
      failedAt: new Date(),
      failureCode,
    })
    .onConflictDoNothing()
  await tx.delete(pendingRating).where(eq(pendingRating.gameHistoryId, work.gameHistoryId))
}

async function processOldestRatingWork(database: Database): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RATING_RECONCILIATION_LOCK_ID})`)
    let removedWork = false
    while (true) {
      const selected = await selectOldestWork(tx)
      if (!selected) {
        return removedWork
      }

      const validation = validateRatingWork(selected)
      if ('failureCode' in validation) {
        await quarantineWork(tx, selected, validation.failureCode)
        return true
      }
      const work = validation.work

      await tx.execute(
        sql`select set_config('euchre.rating_consumer_v2', ${work.source === 'v2' ? '1' : '0'}, true)`,
      )
      const [claim] = await tx
        .insert(ratedMatch)
        .values({ gameHistoryId: work.gameHistoryId })
        .onConflictDoNothing()
        .returning({ gameHistoryId: ratedMatch.gameHistoryId })
      if (!claim) {
        await deleteWork(tx, work)
        removedWork = true
        continue
      }

      const candidateUserIds = [
        ...new Set(
          work.participants.flatMap((userId) => {
            return userId ? [userId] : []
          }),
        ),
      ].sort()
      const existingUsers =
        candidateUserIds.length === 0
          ? []
          : await tx
              .select({ id: user.id })
              .from(user)
              .where(inArray(user.id, candidateUserIds))
              .orderBy(user.id)
      const userIds = existingUsers.map(({ id }) => {
        return id
      })
      const validUserIds = new Set(userIds)

      if (userIds.length > 0) {
        await tx
          .insert(playerRating)
          .values(
            userIds.map((userId) => {
              return { userId, mode: work.mode }
            }),
          )
          .onConflictDoNothing()
        const currentRatings = await tx
          .select({
            userId: playerRating.userId,
            rating: playerRating.rating,
            gamesPlayed: playerRating.gamesPlayed,
          })
          .from(playerRating)
          .where(and(eq(playerRating.mode, work.mode), inArray(playerRating.userId, userIds)))
          .orderBy(playerRating.userId)
          .for('update')
        const ratingsByUser = new Map(
          currentRatings.map((rating) => {
            return [rating.userId, rating] as const
          }),
        )
        const ratingSeats: RatingSeat[] = work.participants.map((userId, seat) => {
          const validUserId = userId && validUserIds.has(userId) ? userId : null
          const current = validUserId ? ratingsByUser.get(validUserId) : undefined
          return {
            seat: seat as Player,
            userId: validUserId,
            rating: current?.rating ?? BASE_SKILL_RATING,
            gamesPlayed: current?.gamesPlayed ?? 0,
          }
        })
        const winner =
          work.forfeitTeam === null
            ? ((work.score0 > work.score1 ? 0 : 1) as Team)
            : ((1 - work.forfeitTeam) as Team)
        const updates = calculateRatingUpdates(ratingSeats, work.handResults ?? [], winner)
        for (const update of updates) {
          await tx
            .update(playerRating)
            .set({
              rating: sql`${playerRating.rating} + ${update.ratingDelta}`,
              gamesPlayed: sql`${playerRating.gamesPlayed} + 1`,
              wins: sql`${playerRating.wins} + ${Number(update.won)}`,
              losses: sql`${playerRating.losses} + ${Number(!update.won)}`,
              handsPlayed: sql`${playerRating.handsPlayed} + ${update.hands}`,
              calls: sql`${playerRating.calls} + ${update.calls}`,
              callsWon: sql`${playerRating.callsWon} + ${update.callsWon}`,
              partnerCalls: sql`${playerRating.partnerCalls} + ${update.partnerCalls}`,
              partnerCallsWon: sql`${playerRating.partnerCallsWon} + ${update.partnerCallsWon}`,
              defenses: sql`${playerRating.defenses} + ${update.defenses}`,
              defensesWon: sql`${playerRating.defensesWon} + ${update.defensesWon}`,
              tricksWon: sql`${playerRating.tricksWon} + ${update.tricksWon}`,
              expectedTricksMilli: sql`${playerRating.expectedTricksMilli} + ${update.expectedTricksMilli}`,
              updatedAt: new Date(),
            })
            .where(and(eq(playerRating.userId, update.userId), eq(playerRating.mode, work.mode)))
        }
      }

      await deleteWork(tx, work)
      return true
    }
  })
}

export async function reconcilePendingRatings(
  database: Database,
  requestedLimit = 100,
): Promise<number> {
  try {
    const limit = Math.max(0, Math.min(Math.floor(requestedLimit), 100))
    let handled = 0
    for (let index = 0; index < limit; index += 1) {
      if (!(await processOldestRatingWork(database))) {
        break
      }
      handled += 1
    }
    return handled
  } catch {
    throw new Error('Rating reconciliation failed.')
  }
}

export function pendingEvidenceFromGame(game: {
  handNumber: number
  handResults?: HandResult[]
  ratingEvidenceComplete?: boolean
  ratingForfeitTeam?: 0 | 1
  ratingMode?: RatingMode
  ratingParticipants?: GameState['ratingParticipants']
}): PendingRatingEvidence {
  return {
    mode: game.ratingMode ?? 'assisted',
    participants: game.ratingParticipants ?? [...EMPTY_PARTICIPANTS],
    forfeitTeam: game.ratingForfeitTeam,
    handResults:
      game.ratingEvidenceComplete && game.handResults?.length === game.handNumber
        ? game.handResults
        : null,
  }
}
