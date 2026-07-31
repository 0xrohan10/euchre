import { and, desc, eq, inArray } from 'drizzle-orm'
import { env } from 'cloudflare:workers'
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'
import type { Database } from '../db/index.server'
import {
  disconnectVote,
  gameHistory,
  gameHistoryParticipant,
  party,
  partyJoin,
  partyMember,
  rematchVote,
  room,
  roomCommand,
  roomCreation,
  roomSeat,
  user,
} from '../db/schema'
import { createGame } from '../game/deal'
import { teamOf, type Player } from '../game/player'
import type { GameHistorySeat, GameHistorySummary } from '../game/history'
import { reduceGame } from '../game/reduce'
import type { GameRules } from '../game/rules'
import type { RatingMode } from '../game/skill'
import type { GameAction, GameState } from '../game/state'
import {
  acceptsRoomAction,
  advanceBot,
  eligibleBotVoters,
  statusForGame,
  statusForPresence,
  type PartyView,
  type PlayerAction,
  type RoomView,
} from '../multiplayer'
import { evaluateTickPolicy } from './tick-policy'
import {
  loadLatestRoomSnapshot,
  loadRoomSnapshot,
  projectRoomSnapshot,
  type RoomSnapshot,
} from './room-view.server'
import {
  pendingEvidenceFromGame,
  persistRatingOutbox,
  type RatingQueueMessage,
} from './rating-reconciliation.server'
import { activeRoomConflicts, activeRoomForUser, lockActiveRoomUsers } from './active-room.server'
import { acquireRoomScheduler } from './room-scheduler-lease.server'

export class GameServiceError extends Data.TaggedError('GameServiceError')<{
  readonly code: 'not-found' | 'forbidden' | 'conflict' | 'stale' | 'invalid' | 'database'
  readonly message: string
}> {}

type SubmitCommand = {
  roomId: string
  commandId: string
  expectedVersion: number
  action: PlayerAction | { type: 'next-hand' } | { type: 'new-match' }
}

type GameServiceShape = {
  createRoom: (
    userId: string,
    operationId: string,
    rules: GameRules,
  ) => Effect.Effect<RoomView, GameServiceError>
  createSinglePlayerRoom: (
    userId: string,
    operationId: string,
    rules: GameRules,
  ) => Effect.Effect<RoomView, GameServiceError>
  roomForCreationOperation: (
    userId: string,
    operationId: string,
    kind: 'multiplayer' | 'single-player',
  ) => Effect.Effect<RoomView | null, GameServiceError>
  hasRoomCreationOperation: (
    userId: string,
    operationId: string,
  ) => Effect.Effect<boolean, GameServiceError>
  currentParty: (userId: string) => Effect.Effect<PartyView | null, GameServiceError>
  createParty: (userId: string) => Effect.Effect<PartyView, GameServiceError>
  joinParty: (userId: string, inviteCode: string) => Effect.Effect<PartyView, GameServiceError>
  leaveParty: (userId: string) => Effect.Effect<void, GameServiceError>
  startPartyRoom: (userId: string, rules: GameRules) => Effect.Effect<RoomView, GameServiceError>
  currentRoom: (userId: string) => Effect.Effect<RoomView | null, GameServiceError>
  waitingLobby: (
    userId: string,
  ) => Effect.Effect<{ party: PartyView | null; room: RoomView | null }, GameServiceError>
  joinRoom: (userId: string, code: string) => Effect.Effect<RoomView, GameServiceError>
  leaveRoom: (userId: string, roomId: string) => Effect.Effect<void, GameServiceError>
  getRoom: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
  submit: (userId: string, command: SubmitCommand) => Effect.Effect<RoomView, GameServiceError>
  voteForBot: (
    userId: string,
    roomId: string,
    disconnectedSeat: Player,
    approve: boolean,
  ) => Effect.Effect<RoomView, GameServiceError>
  confirmRematch: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
  setPresence: (
    userId: string,
    roomId: string,
    connected: boolean,
  ) => Effect.Effect<RoomView, GameServiceError>
  tick: (
    userId: string,
    roomId: string,
    options?: TickOptions,
  ) => Effect.Effect<RoomView, GameServiceError>
  history: (userId: string) => Effect.Effect<GameHistorySummary[], GameServiceError>
}

export type TickOptions = {
  heartbeat?: boolean
  scheduler?: 'legacy' | 'coordinator'
  schedulerOwnerId?: string
  schedulerEpoch?: number
}

export class GameService extends Context.Service<GameService, GameServiceShape>()(
  '@kitty/GameService',
) {}

class DomainError extends Error {
  readonly code: GameServiceError['code']

  constructor(code: GameServiceError['code'], message: string) {
    super(message)
    this.code = code
  }
}

function failure(cause: unknown): GameServiceError {
  if (cause instanceof DomainError) {
    return new GameServiceError({ code: cause.code, message: cause.message })
  }

  console.error('Game service database operation failed', cause)
  return new GameServiceError({ code: 'database', message: 'The game service is unavailable.' })
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => {
    return alphabet[value % alphabet.length]
  }).join('')
}

type RoomReader = Pick<Database, 'select'>
type HistoryWriter = Pick<Database, 'delete' | 'execute' | 'insert' | 'select'>
type CompletedRoom = Pick<typeof room.$inferSelect, 'id' | 'matchId' | 'rules'>
type CompletedGame = Pick<
  GameState,
  | 'handNumber'
  | 'handResults'
  | 'phase'
  | 'ratingEvidenceComplete'
  | 'ratingForfeitTeam'
  | 'ratingMode'
  | 'ratingParticipants'
  | 'score'
>
type HistorySeatInput = Pick<typeof roomSeat.$inferSelect, 'controller' | 'seat' | 'userId'>
type TickSeat = Pick<
  typeof roomSeat.$inferSelect,
  'userId' | 'seat' | 'connected' | 'controller' | 'lastSeenAt'
>

function seatedUserIds(seats: readonly Pick<typeof roomSeat.$inferSelect, 'userId'>[]): string[] {
  return seats.flatMap((seat) => {
    return seat.userId ? [seat.userId] : []
  })
}

function participantSignature(
  seats: readonly Pick<
    typeof roomSeat.$inferSelect,
    'connected' | 'controller' | 'seat' | 'userId'
  >[],
): string {
  return seats
    .filter((seat) => {
      return seat.userId !== null
    })
    .map((seat) => {
      return `${seat.seat}:${seat.userId}:${seat.controller}:${seat.connected}`
    })
    .sort()
    .join('|')
}

async function lockUsersAndRejectActiveRoomConflicts(
  database: Pick<Database, 'select'>,
  userIds: readonly string[],
  targetRoomId?: string,
): Promise<void> {
  const lockedUserIds = await lockTransitionUsers(database, userIds)
  await rejectActiveRoomConflicts(database, lockedUserIds, targetRoomId)
}

async function lockTransitionUsers(
  database: Pick<Database, 'select'>,
  userIds: readonly string[],
): Promise<string[]> {
  const lockedUserIds = await lockActiveRoomUsers(database, userIds)
  if (lockedUserIds.length !== new Set(userIds).size) {
    throw new DomainError('not-found', 'A player account no longer exists.')
  }
  return lockedUserIds
}

async function rejectActiveRoomConflicts(
  database: Pick<Database, 'select'>,
  userIds: readonly string[],
  targetRoomId?: string,
): Promise<void> {
  if ((await activeRoomConflicts(database, userIds, targetRoomId)).length > 0) {
    throw new DomainError('conflict', 'A player is already seated at another active table.')
  }
}
function ratingModeForSeats(
  seats: readonly Pick<typeof roomSeat.$inferSelect, 'userId' | 'controller'>[],
): RatingMode {
  return seats.length < 4 ||
    seats.every((seat) => {
      return seat.userId !== null && seat.controller === 'human'
    })
    ? 'competitive'
    : 'assisted'
}

function withRatingContext(
  game: GameState,
  seats: readonly Pick<
    typeof roomSeat.$inferSelect,
    'seat' | 'userId' | 'controller' | 'connected'
  >[],
): GameState {
  const participants: NonNullable<GameState['ratingParticipants']> = [null, null, null, null]
  for (const seat of seats) {
    participants[seat.seat as Player] =
      seat.controller === 'human' && seat.connected ? seat.userId : null
  }
  return {
    ...game,
    ratingMode: ratingModeForSeats(seats),
    ratingParticipants: participants,
    ratingBotSeats: [false, false, false, false],
  }
}

function enrollRatingParticipant(
  game: GameState | null,
  seat: Pick<typeof roomSeat.$inferSelect, 'seat' | 'userId' | 'controller' | 'connected'>,
): GameState | null {
  if (
    !game ||
    !seat.userId ||
    !seat.connected ||
    seat.controller !== 'human' ||
    !game.ratingParticipants ||
    game.ratingParticipants[seat.seat as Player] ||
    game.ratingBotSeats?.[seat.seat as Player]
  ) {
    return game
  }
  const participants = [...game.ratingParticipants] as NonNullable<GameState['ratingParticipants']>
  participants[seat.seat as Player] = seat.userId
  return { ...game, ratingParticipants: participants }
}

async function recordCompletedMatch(
  record: CompletedRoom,
  game: CompletedGame,
  seats: HistorySeatInput[],
  database: HistoryWriter,
): Promise<string | null> {
  if (game.phase !== 'match-over') {
    return null
  }
  const fallbackParticipants: NonNullable<GameState['ratingParticipants']> = [
    null,
    null,
    null,
    null,
  ]
  for (const seat of seats) {
    fallbackParticipants[seat.seat as Player] = seat.userId
  }
  const participantIds = game.ratingParticipants ?? fallbackParticipants
  const candidateUserIds = [
    ...new Set(
      participantIds.flatMap((userId) => {
        return userId ? [userId] : []
      }),
    ),
  ].sort()
  const players =
    candidateUserIds.length > 0
      ? await database
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, candidateUserIds))
          .orderBy(user.id)
      : []
  const userIds = players.map((player) => {
    return player.id
  })
  const names = new Map(
    players.map((player) => {
      return [player.id, player.name]
    }),
  )
  const historySeats: GameHistorySeat[] = seats.map((seat) => {
    const participantId = participantIds[seat.seat as Player]
    return {
      seat: seat.seat,
      userId: participantId && names.has(participantId) ? participantId : null,
      name: (participantId && names.get(participantId)) || `Bot ${seat.seat}`,
      controller: seat.controller,
    }
  })
  const [created] = await database
    .insert(gameHistory)
    .values({
      sourceRoomId: record.id,
      sourceMatchId: record.matchId,
      score0: game.score[0],
      score1: game.score[1],
      handCount: game.handNumber,
      rules: record.rules,
      seats: historySeats,
    })
    .onConflictDoNothing({ target: gameHistory.sourceMatchId })
    .returning({ id: gameHistory.id })
  const [historyRecord] = created
    ? [{ ...created, seats: historySeats }]
    : await database
        .select({ id: gameHistory.id, seats: gameHistory.seats })
        .from(gameHistory)
        .where(eq(gameHistory.sourceMatchId, record.matchId))
        .limit(1)
  if (!historyRecord) {
    throw new Error('Completed match history could not be claimed.')
  }
  if (created && userIds.length > 0) {
    await database.insert(gameHistoryParticipant).values(
      userIds.map((userId) => {
        return { gameHistoryId: created.id, userId }
      }),
    )
  }

  const ratedParticipantIds: NonNullable<GameState['ratingParticipants']> =
    created || game.ratingParticipants ? participantIds : [null, null, null, null]
  if (!created && !game.ratingParticipants) {
    for (const seat of historyRecord.seats) {
      ratedParticipantIds[seat.seat as Player] = seat.userId
    }
  }
  await persistRatingOutbox(database, historyRecord.id, {
    ...pendingEvidenceFromGame(game),
    participants: ratedParticipantIds,
  })
  return historyRecord.id
}

async function signalRatings(
  queue: Pick<Queue<RatingQueueMessage>, 'send'> | undefined,
  gameHistoryIds: readonly string[],
) {
  if (!queue) {
    return
  }
  for (const gameHistoryId of new Set(gameHistoryIds)) {
    try {
      await queue.send({ gameHistoryId })
    } catch {
      console.error('Failed to send rating reconciliation signal')
    }
  }
}

async function viewParty(userId: string, database: RoomReader): Promise<PartyView | null> {
  const [membership] = await database
    .select({ partyId: partyMember.partyId })
    .from(partyMember)
    .where(eq(partyMember.userId, userId))
    .limit(1)
  if (!membership) {
    return null
  }
  const [record] = await database
    .select()
    .from(party)
    .where(eq(party.id, membership.partyId))
    .limit(1)
  if (!record) {
    return null
  }
  const members = await database
    .select({ userId: partyMember.userId, name: user.name })
    .from(partyMember)
    .innerJoin(user, eq(partyMember.userId, user.id))
    .where(eq(partyMember.partyId, record.id))
    .orderBy(partyMember.joinedAt)
  return { id: record.id, ownerUserId: record.ownerUserId, inviteCode: record.inviteCode, members }
}

async function viewPartyJoin(
  userId: string,
  inviteCode: string,
  database: RoomReader,
): Promise<PartyView | null> {
  const [join] = await database
    .select({ partyId: partyJoin.partyId })
    .from(partyJoin)
    .where(and(eq(partyJoin.userId, userId), eq(partyJoin.inviteCode, inviteCode)))
    .limit(1)
  if (!join) {
    return null
  }
  const view = await viewParty(userId, database)
  if (!view || view.id !== join.partyId) {
    throw new DomainError('conflict', 'You are already in another partnership.')
  }
  return view
}

async function viewRoom(userId: string, roomId: string, database: RoomReader): Promise<RoomView> {
  return viewFromSnapshot(userId, await loadRoomSnapshot(database, roomId))
}

function viewFromSnapshot(userId: string, snapshot: RoomSnapshot | null): RoomView {
  if (!snapshot) {
    throw new DomainError('not-found', 'Table not found.')
  }
  const view = projectRoomSnapshot(snapshot, userId)
  if (!view) {
    throw new DomainError('forbidden', 'You are not seated at this table.')
  }
  return view
}

// Keep the service definition flat so changes do not reindent this large module.
const createGameService = (
  db: Database,
  ratingQueue: Pick<Queue<RatingQueueMessage>, 'send'> | undefined,
) =>
  // oxlint-disable-next-line arrow-body-style
  GameService.of({
    history: Effect.fn('GameService.history')((userId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const records = await tx
              .select({
                id: gameHistory.id,
                score0: gameHistory.score0,
                score1: gameHistory.score1,
                handCount: gameHistory.handCount,
                rules: gameHistory.rules,
                seats: gameHistory.seats,
                completedAt: gameHistory.completedAt,
              })
              .from(gameHistoryParticipant)
              .innerJoin(gameHistory, eq(gameHistoryParticipant.gameHistoryId, gameHistory.id))
              .where(eq(gameHistoryParticipant.userId, userId))
              .orderBy(desc(gameHistory.completedAt))
              .limit(50)
            return records.map(({ score0, score1, ...record }) => {
              return {
                ...record,
                score: [score0, score1] as [number, number],
                winner: (score0 > score1 ? 0 : 1) as 0 | 1,
              }
            })
          })
        },
        catch: failure,
      })
    }),
    tick: Effect.fn('GameService.tick')((userId: string, roomId: string, options?: TickOptions) => {
      return Effect.tryPromise({
        try: async () => {
          const toPolicyInput = (
            nowMs: number,
            record: typeof room.$inferSelect,
            seats: TickSeat[],
          ) => {
            return {
              nowMs,
              callerUserId: userId,
              heartbeatEnabled: options?.heartbeat,
              room: {
                status: record.status,
                updatedAtMs: record.updatedAt.getTime(),
                gamePhase: record.game?.phase ?? null,
                hostUserId: record.hostUserId,
                activePlayerSeat: record.game?.activePlayer ?? null,
              },
              seats: seats.map((seat) => {
                return {
                  userId: seat.userId,
                  seat: seat.seat,
                  connected: seat.connected,
                  controller: seat.controller,
                  lastSeenAtMs: seat.lastSeenAt.getTime(),
                }
              }),
            }
          }

          // REPEATABLE READ keeps room+seats+view on one snapshot without taking FOR UPDATE,
          // so idle ticks stay consistent and still do not contend with command locks.
          const preflight = await db.transaction(
            async (tx) => {
              const now = new Date()
              const snapshot = await loadRoomSnapshot(tx, roomId)
              viewFromSnapshot(userId, snapshot)
              const { room: preflightRoom, seats: preflightSeats } = snapshot!
              const preflightPolicy = evaluateTickPolicy(
                toPolicyInput(now.getTime(), preflightRoom, preflightSeats),
              )
              if (!preflightPolicy.sharedMutationMayBeNeeded) {
                return {
                  kind: 'view' as const,
                  view: viewFromSnapshot(userId, snapshot),
                }
              }
              return {
                kind: 'mutate' as const,
                participantSignature: participantSignature(preflightSeats),
                status: preflightRoom.status,
                userIds: seatedUserIds(preflightSeats),
              }
            },
            { isolationLevel: 'repeatable read' },
          )
          if (preflight.kind === 'view') {
            return preflight.view
          }
          const ratingSignals: string[] = []
          const result = await db.transaction(async (tx) => {
            const schedulerMode = options?.scheduler ?? 'legacy'
            const scheduler = await acquireRoomScheduler(
              tx,
              roomId,
              schedulerMode,
              options?.schedulerOwnerId ?? '00000000-0000-4000-8000-000000000001',
              undefined,
              undefined,
              options?.schedulerEpoch,
            )
            if (!scheduler) {
              if (schedulerMode === 'coordinator') {
                throw new DomainError('stale', 'Room coordinator ownership was lost.')
              }
              return viewRoom(userId, roomId, tx)
            }
            if (preflight.status === 'finished') {
              await lockUsersAndRejectActiveRoomConflicts(tx, preflight.userIds, roomId)
            }
            const lockedNow = new Date()
            const snapshot = await loadRoomSnapshot(tx, roomId, { forUpdate: true })
            viewFromSnapshot(userId, snapshot)
            const { room: record, seats } = snapshot!
            if (
              (preflight.status === 'finished' &&
                participantSignature(seats) !== preflight.participantSignature) ||
              (preflight.status !== 'finished' && record.status === 'finished')
            ) {
              throw new DomainError('conflict', 'Table membership changed. Try again.')
            }
            const caller = seats.find((seat) => {
              return seat.userId === userId
            })
            if (!caller) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            const lockedPolicy = evaluateTickPolicy(
              toPolicyInput(lockedNow.getTime(), record, seats),
            )
            if (!lockedPolicy.sharedMutationMayBeNeeded) {
              return viewFromSnapshot(userId, snapshot)
            }

            const callerReconnected = lockedPolicy.reconnectWorkDue
            let renewedSeats = seats
            if (lockedPolicy.heartbeatWriteDue || callerReconnected) {
              await tx
                .update(roomSeat)
                .set({ connected: true, controller: 'human', lastSeenAt: lockedNow })
                .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
              renewedSeats = seats.map((seat) => {
                return seat.userId === userId
                  ? {
                      ...seat,
                      connected: true,
                      controller: 'human' as const,
                      lastSeenAt: lockedNow,
                    }
                  : seat
              })
            }
            if (callerReconnected) {
              await tx
                .delete(disconnectVote)
                .where(
                  and(
                    eq(disconnectVote.roomId, roomId),
                    eq(disconnectVote.disconnectedSeat, caller.seat),
                  ),
                )
            }
            const staleSeats = renewedSeats.filter((seat) => {
              return (
                (options?.heartbeat === false || seat.userId !== userId) &&
                seat.connected &&
                seat.controller === 'human' &&
                lockedNow.getTime() - seat.lastSeenAt.getTime() >= 15_000
              )
            })
            if (staleSeats.length > 0) {
              await tx
                .update(roomSeat)
                .set({ connected: false })
                .where(
                  and(
                    eq(roomSeat.roomId, roomId),
                    inArray(
                      roomSeat.seat,
                      staleSeats.map((seat) => {
                        return seat.seat
                      }),
                    ),
                  ),
                )
            }
            const currentSeats = renewedSeats.map((seat) => {
              return staleSeats.some((stale) => {
                return stale.seat === seat.seat
              })
                ? { ...seat, connected: false }
                : seat
            })
            const currentCaller = currentSeats.find((seat) => {
              return seat.userId === userId
            })!
            const enrolledGame = enrollRatingParticipant(record.game, currentCaller)
            const hasDisconnectedHuman = currentSeats.some((seat) => {
              return !seat.connected && seat.controller === 'human'
            })
            const hostDisconnected = currentSeats.some((seat) => {
              return (
                seat.userId === record.hostUserId && !seat.connected && seat.controller === 'human'
              )
            })
            const status = statusForPresence(
              record.status,
              record.game?.phase ?? null,
              hasDisconnectedHuman,
              hostDisconnected,
            )
            // Presence/status-only changes must not bump `version` — that field is the CAS
            // token for game commands. Bumping it on reconnect makes every in-flight play fail.
            // Clients still accept same-version presence updates.
            if (
              callerReconnected ||
              staleSeats.length > 0 ||
              status !== record.status ||
              lockedPolicy.statusRepairDue ||
              enrolledGame !== record.game
            ) {
              await tx
                .update(room)
                .set({ status, game: enrolledGame, updatedAt: lockedNow })
                .where(eq(room.id, roomId))
              snapshot!.room = {
                ...snapshot!.room,
                status,
                game: enrolledGame,
                updatedAt: lockedNow,
              }
            }
            if (staleSeats.length === 0 && enrolledGame && status === 'playing') {
              const elapsed = lockedNow.getTime() - record.updatedAt.getTime()
              const botSeat = currentSeats.find((seat) => {
                return seat.seat === enrolledGame.activePlayer && seat.controller === 'bot'
              })
              const botActed =
                enrolledGame.phase !== 'trick-complete' && elapsed >= 900 && botSeat !== undefined
              const advanced =
                enrolledGame.phase === 'trick-complete'
                  ? elapsed >= 1_600
                    ? reduceGame(enrolledGame, { type: 'collect-trick' })
                    : enrolledGame
                  : elapsed >= 900
                    ? advanceBot(enrolledGame, currentSeats)
                    : enrolledGame
              let game = advanced
              if (botActed && botSeat && advanced !== enrolledGame) {
                const ratingBotSeats = [
                  ...(enrolledGame.ratingBotSeats ?? [false, false, false, false]),
                ] as [boolean, boolean, boolean, boolean]
                ratingBotSeats[botSeat.seat as Player] = true
                const replacedParticipant =
                  enrolledGame.ratingParticipants?.[botSeat.seat as Player]
                game = {
                  ...advanced,
                  ratingBotSeats,
                  ratingEvidenceComplete: replacedParticipant
                    ? false
                    : advanced.ratingEvidenceComplete,
                  ratingForfeitTeam:
                    replacedParticipant && advanced.ratingForfeitTeam === undefined
                      ? teamOf(botSeat.seat as Player)
                      : advanced.ratingForfeitTeam,
                }
              }
              if (game !== enrolledGame) {
                const gameHistoryId = await recordCompletedMatch(record, game, currentSeats, tx)
                if (gameHistoryId) {
                  ratingSignals.push(gameHistoryId)
                }
                await tx
                  .update(room)
                  .set({
                    game,
                    status: statusForGame(game),
                    version: record.version + 1,
                    updatedAt: lockedNow,
                  })
                  .where(eq(room.id, roomId))
                snapshot!.room = {
                  ...snapshot!.room,
                  game,
                  status: statusForGame(game),
                  version: record.version + 1,
                  updatedAt: lockedNow,
                }
              }
            }
            snapshot!.seats = currentSeats
            if (callerReconnected) {
              snapshot!.disconnectVotes = snapshot!.disconnectVotes.filter((vote) => {
                return vote.disconnectedSeat !== caller.seat
              })
            }
            return viewFromSnapshot(userId, snapshot)
          })
          await signalRatings(ratingQueue, ratingSignals)
          return result
        },
        catch: failure,
      })
    }),
    currentRoom: Effect.fn('GameService.currentRoom')((userId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const snapshot = await loadLatestRoomSnapshot(tx, userId)
            return snapshot ? viewFromSnapshot(userId, snapshot) : null
          })
        },
        catch: failure,
      })
    }),
    currentParty: Effect.fn('GameService.currentParty')((userId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction((tx) => {
            return viewParty(userId, tx)
          })
        },
        catch: failure,
      })
    }),
    waitingLobby: Effect.fn('GameService.waitingLobby')((userId: string) => {
      return Effect.tryPromise({
        try: async () => {
          const partyView = await db.transaction((tx) => {
            return viewParty(userId, tx)
          })
          const roomView = await db.transaction(async (tx) => {
            const snapshot = await loadLatestRoomSnapshot(tx, userId)
            return snapshot ? viewFromSnapshot(userId, snapshot) : null
          })
          return { party: partyView, room: roomView }
        },
        catch: failure,
      })
    }),
    createParty: Effect.fn('GameService.createParty')((userId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const existing = await viewParty(userId, tx)
            if (existing) {
              return existing
            }
            const [created] = await tx.insert(party).values({ ownerUserId: userId }).returning()
            await tx.insert(partyMember).values({ partyId: created.id, userId })
            return (await viewParty(userId, tx))!
          })
        },
        catch: failure,
      })
    }),
    joinParty: Effect.fn('GameService.joinParty')((userId: string, inviteCode: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const retry = await viewPartyJoin(userId, inviteCode, tx)
            if (retry) {
              return retry
            }
            if (await viewParty(userId, tx)) {
              throw new DomainError('conflict', 'You are already in another partnership.')
            }
            const [target] = await tx
              .select({ id: party.id })
              .from(party)
              .where(eq(party.inviteCode, inviteCode))
              .limit(1)
            if (!target) {
              throw new DomainError('not-found', 'Partner invite not found.')
            }
            const [record] = await tx
              .select()
              .from(party)
              .where(eq(party.id, target.id))
              .for('update', { of: party })
              .limit(1)
            const retryAfterLock = await viewPartyJoin(userId, inviteCode, tx)
            if (retryAfterLock) {
              return retryAfterLock
            }
            if (await viewParty(userId, tx)) {
              throw new DomainError('conflict', 'You are already in another partnership.')
            }
            if (!record || record.inviteCode !== inviteCode) {
              throw new DomainError('not-found', 'Partner invite not found.')
            }
            const members = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, record.id))
            if (members.length >= 2) {
              throw new DomainError('conflict', 'This partner invite has already been used.')
            }
            const inserted = await tx
              .insert(partyMember)
              .values({ partyId: record.id, userId })
              .onConflictDoNothing()
              .returning({ partyId: partyMember.partyId })
            if (inserted.length === 0) {
              const concurrentRetry = await viewPartyJoin(userId, inviteCode, tx)
              if (concurrentRetry) {
                return concurrentRetry
              }
              throw new DomainError('conflict', 'You are already in another partnership.')
            }
            await tx.insert(partyJoin).values({ userId, inviteCode, partyId: record.id })
            await tx
              .update(party)
              .set({ inviteCode: crypto.randomUUID(), updatedAt: new Date() })
              .where(eq(party.id, record.id))
            return (await viewParty(userId, tx))!
          })
        },
        catch: failure,
      })
    }),
    leaveParty: Effect.fn('GameService.leaveParty')((userId: string) => {
      return Effect.tryPromise({
        try: async () => {
          await db.transaction(async (tx) => {
            const [membership] = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.userId, userId))
              .limit(1)
            if (!membership) {
              throw new DomainError('not-found', 'Partnership not found.')
            }
            const [record] = await tx
              .select()
              .from(party)
              .where(eq(party.id, membership.partyId))
              .for('update', { of: party })
              .limit(1)
            if (!record) {
              throw new DomainError('not-found', 'Partnership not found.')
            }
            const members = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, record.id))
              .orderBy(partyMember.joinedAt)
            const remaining = members.filter((member) => {
              return member.userId !== userId
            })
            const [activeRoom] = await tx
              .select()
              .from(room)
              .where(
                and(
                  eq(room.partyId, record.id),
                  inArray(room.status, ['playing', 'paused', 'finished']),
                ),
              )
              .orderBy(desc(room.updatedAt))
              .for('update', { of: room })
              .limit(1)
            if (activeRoom?.game) {
              const seats = await tx
                .select()
                .from(roomSeat)
                .where(eq(roomSeat.roomId, activeRoom.id))
                .orderBy(roomSeat.seat)
              const departingSeat = seats.find((seat) => {
                return seat.userId === userId
              })
              if (departingSeat) {
                const departingPlayer = departingSeat.seat as Player
                const game =
                  activeRoom.game.ratingParticipants?.[departingPlayer] === userId
                    ? {
                        ...activeRoom.game,
                        ratingEvidenceComplete: false,
                        ratingForfeitTeam:
                          activeRoom.game.ratingForfeitTeam ?? teamOf(departingPlayer),
                      }
                    : activeRoom.game
                await tx
                  .update(roomSeat)
                  .set({
                    userId: null,
                    controller: 'bot',
                    connected: false,
                    lastSeenAt: new Date(),
                  })
                  .where(
                    and(eq(roomSeat.roomId, activeRoom.id), eq(roomSeat.seat, departingSeat.seat)),
                  )
                await tx
                  .delete(disconnectVote)
                  .where(
                    and(
                      eq(disconnectVote.roomId, activeRoom.id),
                      eq(disconnectVote.disconnectedSeat, departingSeat.seat),
                    ),
                  )
                await tx
                  .delete(rematchVote)
                  .where(and(eq(rematchVote.roomId, activeRoom.id), eq(rematchVote.userId, userId)))
                const controlledSeats = seats.map((seat) => {
                  return seat.seat === departingSeat.seat
                    ? { ...seat, userId: null, controller: 'bot' as const, connected: false }
                    : seat
                })
                const hasDisconnectedHuman = controlledSeats.some((seat) => {
                  return !seat.connected && seat.controller === 'human'
                })
                const nextOwner = remaining[0]?.userId
                await tx
                  .update(room)
                  .set({
                    hostUserId:
                      activeRoom.hostUserId === userId && nextOwner
                        ? nextOwner
                        : activeRoom.hostUserId,
                    status:
                      activeRoom.status === 'finished'
                        ? 'finished'
                        : statusForPresence(
                            statusForGame(game),
                            game.phase,
                            hasDisconnectedHuman,
                            false,
                          ),
                    version: activeRoom.version + 1,
                    game,
                    updatedAt: new Date(),
                  })
                  .where(eq(room.id, activeRoom.id))
              }
            }
            await tx
              .delete(partyMember)
              .where(and(eq(partyMember.partyId, record.id), eq(partyMember.userId, userId)))
            if (remaining.length === 0) {
              await tx.delete(party).where(eq(party.id, record.id))
            } else {
              await tx
                .update(party)
                .set({
                  ownerUserId: remaining[0].userId,
                  inviteCode: crypto.randomUUID(),
                  updatedAt: new Date(),
                })
                .where(eq(party.id, record.id))
            }
          })
        },
        catch: failure,
      })
    }),
    startPartyRoom: Effect.fn('GameService.startPartyRoom')((userId: string, rules: GameRules) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [membershipPreflight] = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.userId, userId))
              .limit(1)
            if (!membershipPreflight) {
              throw new DomainError('not-found', 'Partnership not found.')
            }
            const memberPreflight = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, membershipPreflight.partyId))
              .orderBy(partyMember.joinedAt)
            const lockedUserIds = await lockTransitionUsers(
              tx,
              memberPreflight.map((member) => {
                return member.userId
              }),
            )
            const [record] = await tx
              .select()
              .from(party)
              .where(eq(party.id, membershipPreflight.partyId))
              .for('update', { of: party })
              .limit(1)
            if (!record || record.ownerUserId !== userId) {
              throw new DomainError('forbidden', 'Only the party creator can start a match.')
            }
            const members = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, record.id))
              .orderBy(partyMember.joinedAt)
            if (
              members
                .map(({ userId: memberUserId }) => {
                  return memberUserId
                })
                .sort()
                .join('|') !== lockedUserIds.join('|')
            ) {
              throw new DomainError('conflict', 'Partnership membership changed. Try again.')
            }
            if (members.length !== 2) {
              throw new DomainError('conflict', 'Invite a partner before starting a match.')
            }
            const [activeRoom] = await tx
              .select()
              .from(room)
              .where(and(eq(room.partyId, record.id), inArray(room.status, ['playing', 'paused'])))
              .orderBy(desc(room.updatedAt))
              .limit(1)
            await rejectActiveRoomConflicts(tx, lockedUserIds, activeRoom?.id)
            if (activeRoom) {
              const activeHumans = await tx
                .select({ userId: roomSeat.userId })
                .from(roomSeat)
                .where(and(eq(roomSeat.roomId, activeRoom.id), eq(roomSeat.controller, 'human')))
              const activeHumanUserIds = activeHumans
                .flatMap(({ userId: activeUserId }) => {
                  return activeUserId ? [activeUserId] : []
                })
                .sort()
              if (activeHumanUserIds.join('|') !== lockedUserIds.join('|')) {
                throw new DomainError(
                  'conflict',
                  'The active partnership table no longer matches the current party.',
                )
              }
              return viewRoom(userId, activeRoom.id, tx)
            }
            const partner = members.find((member) => {
              return member.userId !== userId
            })!
            const seatValues = [
              {
                roomId: '',
                seat: 0,
                userId,
                connected: true,
                controller: 'human' as const,
              },
              {
                roomId: '',
                seat: 1,
                userId: null,
                controller: 'bot' as const,
                connected: false,
              },
              {
                roomId: '',
                seat: 2,
                userId: partner.userId,
                connected: false,
                controller: 'human' as const,
              },
              {
                roomId: '',
                seat: 3,
                userId: null,
                controller: 'bot' as const,
                connected: false,
              },
            ]
            const game = withRatingContext(createGame(undefined, rules), seatValues)
            const [created] = await tx
              .insert(room)
              .values({
                code: randomCode(),
                hostUserId: userId,
                partyId: record.id,
                rules,
                status: 'playing',
                game,
              })
              .returning()
            await tx.insert(roomSeat).values([
              { roomId: created.id, seat: 0, userId, connected: true },
              { roomId: created.id, seat: 1, controller: 'bot' },
              { roomId: created.id, seat: 2, userId: partner.userId, connected: false },
              { roomId: created.id, seat: 3, controller: 'bot' },
            ])
            return viewRoom(userId, created.id, tx)
          })
        },
        catch: failure,
      })
    }),
    createRoom: Effect.fn('GameService.createRoom')(
      (userId: string, operationId: string, rules: GameRules) => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              await lockTransitionUsers(tx, [userId])
              const [claim] = await tx
                .insert(roomCreation)
                .values({ userId, operationId, operationKind: 'multiplayer' })
                .onConflictDoNothing()
                .returning({ operationId: roomCreation.operationId })
              if (!claim) {
                const [existing] = await tx
                  .select()
                  .from(roomCreation)
                  .where(
                    and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                  )
                  .limit(1)
                if (!existing || existing.operationKind !== 'multiplayer' || !existing.roomId) {
                  throw new DomainError('conflict', 'Room creation operation does not match.')
                }
                return viewRoom(userId, existing.roomId, tx)
              }
              const activeRoom = await activeRoomForUser(tx, userId)
              if (activeRoom) {
                await tx
                  .update(roomCreation)
                  .set({ roomId: activeRoom.id })
                  .where(
                    and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                  )
                return viewRoom(userId, activeRoom.id, tx)
              }
              const [created] = await tx
                .insert(room)
                .values({ code: randomCode(), hostUserId: userId, rules })
                .returning()
              await tx
                .insert(roomSeat)
                .values({ roomId: created.id, seat: 0, userId, connected: true })
              await tx
                .update(roomCreation)
                .set({ roomId: created.id })
                .where(
                  and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                )
              return viewRoom(userId, created.id, tx)
            })
          },
          catch: failure,
        })
      },
    ),
    createSinglePlayerRoom: Effect.fn('GameService.createSinglePlayerRoom')(
      (userId: string, operationId: string, rules: GameRules) => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              await lockTransitionUsers(tx, [userId])
              const [claim] = await tx
                .insert(roomCreation)
                .values({ userId, operationId, operationKind: 'single-player' })
                .onConflictDoNothing()
                .returning({ operationId: roomCreation.operationId })
              if (!claim) {
                const [existing] = await tx
                  .select()
                  .from(roomCreation)
                  .where(
                    and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                  )
                  .limit(1)
                if (!existing || existing.operationKind !== 'single-player' || !existing.roomId) {
                  throw new DomainError('conflict', 'Room creation operation does not match.')
                }
                return viewRoom(userId, existing.roomId, tx)
              }
              const activeRoom = await activeRoomForUser(tx, userId)
              if (activeRoom) {
                await tx
                  .update(roomCreation)
                  .set({ roomId: activeRoom.id })
                  .where(
                    and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                  )
                return viewRoom(userId, activeRoom.id, tx)
              }
              const seatValues = [
                {
                  roomId: '',
                  seat: 0,
                  userId,
                  connected: true,
                  controller: 'human' as const,
                },
                {
                  roomId: '',
                  seat: 1,
                  userId: null,
                  controller: 'bot' as const,
                  connected: false,
                },
                {
                  roomId: '',
                  seat: 2,
                  userId: null,
                  controller: 'bot' as const,
                  connected: false,
                },
                {
                  roomId: '',
                  seat: 3,
                  userId: null,
                  controller: 'bot' as const,
                  connected: false,
                },
              ]
              const game = withRatingContext(createGame(undefined, rules), seatValues)
              const [created] = await tx
                .insert(room)
                .values({
                  code: randomCode(),
                  hostUserId: userId,
                  rules,
                  status: 'playing',
                  game,
                })
                .returning()
              await tx.insert(roomSeat).values([
                { roomId: created.id, seat: 0, userId, connected: true },
                { roomId: created.id, seat: 1, controller: 'bot' },
                { roomId: created.id, seat: 2, controller: 'bot' },
                { roomId: created.id, seat: 3, controller: 'bot' },
              ])
              await tx
                .update(roomCreation)
                .set({ roomId: created.id })
                .where(
                  and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                )
              return viewRoom(userId, created.id, tx)
            })
          },
          catch: failure,
        })
      },
    ),
    roomForCreationOperation: Effect.fn('GameService.roomForCreationOperation')(
      (userId: string, operationId: string, kind: 'multiplayer' | 'single-player') => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              const [creation] = await tx
                .select()
                .from(roomCreation)
                .where(
                  and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
                )
                .limit(1)
              if (!creation) {
                return null
              }
              if (creation.operationKind !== kind) {
                throw new DomainError('conflict', 'Room creation operation does not match.')
              }
              return creation.roomId ? viewRoom(userId, creation.roomId, tx) : null
            })
          },
          catch: failure,
        })
      },
    ),
    hasRoomCreationOperation: Effect.fn('GameService.hasRoomCreationOperation')(
      (userId: string, operationId: string) => {
        return Effect.tryPromise({
          try: async () => {
            const [creation] = await db
              .select({ operationId: roomCreation.operationId })
              .from(roomCreation)
              .where(
                and(eq(roomCreation.userId, userId), eq(roomCreation.operationId, operationId)),
              )
              .limit(1)
            return creation !== undefined
          },
          catch: failure,
        })
      },
    ),
    joinRoom: Effect.fn('GameService.joinRoom')((userId: string, code: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [target] = await tx
              .select({ id: room.id })
              .from(room)
              .where(eq(room.code, code.toUpperCase()))
              .limit(1)
            if (!target) {
              throw new DomainError('not-found', 'Invite code not found.')
            }
            await lockUsersAndRejectActiveRoomConflicts(tx, [userId], target.id)
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, target.id))
              .for('update', { of: room })
              .limit(1)
            if (!record || record.code !== code.toUpperCase()) {
              throw new DomainError('not-found', 'Invite code not found.')
            }
            const seats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, record.id))
              .orderBy(roomSeat.seat)
            const existing = seats.find((seat) => {
              return seat.userId === userId
            })
            if (existing) {
              return viewRoom(userId, record.id, tx)
            }
            if (record.status !== 'lobby' || seats.length >= 4) {
              throw new DomainError('conflict', 'This table is already full.')
            }
            await tx
              .insert(roomSeat)
              .values({ roomId: record.id, seat: seats.length, userId, connected: true })
            if (seats.length === 3) {
              await tx
                .update(room)
                .set({
                  status: 'playing',
                  game: withRatingContext(createGame(undefined, record.rules), [
                    ...seats,
                    { seat: 3, userId, controller: 'human', connected: true },
                  ]),
                  version: record.version + 1,
                  updatedAt: new Date(),
                })
                .where(eq(room.id, record.id))
            } else {
              await tx
                .update(room)
                .set({ version: record.version + 1, updatedAt: new Date() })
                .where(eq(room.id, record.id))
            }
            return viewRoom(userId, record.id, tx)
          })
        },
        catch: failure,
      })
    }),
    leaveRoom: Effect.fn('GameService.leaveRoom')((userId: string, roomId: string) => {
      return Effect.tryPromise({
        try: async () => {
          const ratingSignals: string[] = []
          await db.transaction(async (tx) => {
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, roomId))
              .for('update', { of: room })
              .limit(1)
            if (!record) {
              throw new DomainError('not-found', 'Table not found.')
            }
            const seats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, roomId))
              .orderBy(roomSeat.seat)
            if (
              !seats.some((seat) => {
                return seat.userId === userId
              })
            ) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            const singlePlayer =
              seats.length === 4 &&
              seats.every((seat) => {
                return seat.userId === userId || (seat.userId === null && seat.controller === 'bot')
              })
            if (record.game) {
              const gameHistoryId = await recordCompletedMatch(record, record.game, seats, tx)
              if (gameHistoryId) {
                ratingSignals.push(gameHistoryId)
              }
            }
            if (record.partyId && record.status === 'finished') {
              await tx.delete(room).where(eq(room.id, roomId))
              return
            }
            if (record.status !== 'lobby') {
              if (!singlePlayer) {
                throw new DomainError(
                  'conflict',
                  'You can only leave a multiplayer table before the match starts.',
                )
              }
              await tx.delete(room).where(eq(room.id, roomId))
              return
            }
            const remaining = seats.filter((seat) => {
              return seat.userId !== userId
            })
            await tx
              .delete(roomSeat)
              .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
            if (remaining.length === 0) {
              await tx.delete(room).where(eq(room.id, roomId))
              return
            }
            for (const [seat, occupant] of remaining.entries()) {
              if (occupant.seat !== seat) {
                await tx
                  .update(roomSeat)
                  .set({ seat })
                  .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, occupant.userId!)))
              }
            }
            const hostUserId =
              record.hostUserId === userId ? remaining[0].userId! : record.hostUserId
            await tx
              .update(room)
              .set({ hostUserId, version: record.version + 1, updatedAt: new Date() })
              .where(eq(room.id, roomId))
          })
          await signalRatings(ratingQueue, ratingSignals)
        },
        catch: failure,
      })
    }),
    getRoom: Effect.fn('GameService.getRoom')((userId: string, roomId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction((tx) => {
            return viewRoom(userId, roomId, tx)
          })
        },
        catch: failure,
      })
    }),
    submit: Effect.fn('GameService.submit')((userId: string, command: SubmitCommand) => {
      return Effect.tryPromise({
        try: async () => {
          const ratingSignals: string[] = []
          const result = await db.transaction(async (tx) => {
            let rematchParticipants: string | undefined
            if (command.action.type === 'new-match') {
              const preflightSeats = await tx
                .select()
                .from(roomSeat)
                .where(eq(roomSeat.roomId, command.roomId))
                .orderBy(roomSeat.seat)
              rematchParticipants = participantSignature(preflightSeats)
              await lockTransitionUsers(tx, seatedUserIds(preflightSeats))
            }
            const snapshot = await loadRoomSnapshot(tx, command.roomId, {
              commandId: command.commandId,
              forUpdate: true,
            })
            const record = snapshot?.room
            if (!snapshot || !record?.game) {
              throw new DomainError('not-found', 'Active game not found.')
            }
            const seats = snapshot.seats
            const actor = seats.find((seat) => {
              return seat.userId === userId
            })
            if (!actor) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            if (snapshot.command) {
              return viewFromSnapshot(userId, snapshot)
            }
            if (
              rematchParticipants !== undefined &&
              participantSignature(seats) !== rematchParticipants
            ) {
              throw new DomainError('conflict', 'Table membership changed. Try the rematch again.')
            }
            if (command.action.type === 'new-match') {
              await rejectActiveRoomConflicts(tx, seatedUserIds(seats), command.roomId)
            }
            if (record.version !== command.expectedVersion) {
              throw new DomainError('stale', 'Your game view is stale.')
            }
            if (!acceptsRoomAction(record.status, record.game.phase, command.action.type)) {
              throw new DomainError(
                'conflict',
                'That action is not available in the current game state.',
              )
            }
            if (actor.controller !== 'human') {
              throw new DomainError('forbidden', 'This seat is currently controlled by a bot.')
            }
            const hostAction =
              command.action.type === 'next-hand' || command.action.type === 'new-match'
            if (record.partyId && command.action.type === 'new-match') {
              throw new DomainError('invalid', 'Both partners must confirm a rematch.')
            }
            if (
              command.action.type === 'new-match' &&
              seats.every((seat) => {
                return seat.userId !== null
              }) &&
              seats.some((seat) => {
                return !seat.connected || seat.controller !== 'human'
              })
            ) {
              throw new DomainError('conflict', 'All players must reconnect before a rematch.')
            }
            if (hostAction && record.hostUserId !== userId) {
              throw new DomainError('forbidden', 'Only the host can advance the match.')
            }
            if (!hostAction && record.game.activePlayer !== actor.seat) {
              throw new DomainError('forbidden', 'It is not your turn.')
            }
            if (command.action.type === 'new-match') {
              const gameHistoryId = await recordCompletedMatch(record, record.game, seats, tx)
              if (gameHistoryId) {
                ratingSignals.push(gameHistoryId)
              }
            }
            const nextGame = reduceGame(record.game, command.action as GameAction)
            const reduced =
              command.action.type === 'new-match' ? withRatingContext(nextGame, seats) : nextGame
            if (reduced === record.game) {
              throw new DomainError('invalid', 'That action is not legal now.')
            }
            const hasDisconnectedHuman = seats.some((seat) => {
              return !seat.connected && seat.controller === 'human'
            })
            const hostDisconnected = seats.some((seat) => {
              return (
                seat.userId === record.hostUserId && !seat.connected && seat.controller === 'human'
              )
            })
            const status = statusForPresence(
              statusForGame(reduced),
              reduced.phase,
              hasDisconnectedHuman,
              hostDisconnected,
            )
            if (command.action.type !== 'new-match') {
              const gameHistoryId = await recordCompletedMatch(record, reduced, seats, tx)
              if (gameHistoryId) {
                ratingSignals.push(gameHistoryId)
              }
            }
            await tx.insert(roomCommand).values({
              roomId: command.roomId,
              commandId: command.commandId,
              userId,
              action: command.action as GameAction,
            })
            const matchId =
              command.action.type === 'new-match' ? crypto.randomUUID() : record.matchId
            const updatedAt = new Date()
            await tx
              .update(room)
              .set({
                game: reduced,
                status,
                matchId,
                version: record.version + 1,
                updatedAt,
              })
              .where(eq(room.id, command.roomId))
            snapshot.room = {
              ...record,
              game: reduced,
              status,
              matchId,
              version: record.version + 1,
              updatedAt,
            }
            return viewFromSnapshot(userId, snapshot)
          })
          await signalRatings(ratingQueue, ratingSignals)
          return result
        },
        catch: failure,
      })
    }),
    voteForBot: Effect.fn('GameService.voteForBot')(
      (userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              const snapshot = await loadRoomSnapshot(tx, roomId, { forUpdate: true })
              const record = snapshot?.room
              const seats = snapshot?.seats ?? []
              const voter = seats.find((seat) => {
                return seat.userId === userId
              })
              const disconnected = seats.find((seat) => {
                return (
                  seat.seat === disconnectedSeat && !seat.connected && seat.controller === 'human'
                )
              })
              if (
                !snapshot ||
                !record?.game ||
                record.status !== 'paused' ||
                !voter ||
                !disconnected ||
                voter.seat === disconnected.seat ||
                !voter.connected ||
                voter.controller !== 'human'
              ) {
                throw new DomainError('invalid', 'There is no active replacement vote.')
              }
              const eligibleVoters = eligibleBotVoters(seats, disconnected.seat as Player)
              const previousVote = snapshot.disconnectVotes.find((vote) => {
                return vote.disconnectedSeat === disconnected.seat && vote.voterUserId === userId
              })
              await tx
                .insert(disconnectVote)
                .values({
                  roomId,
                  disconnectedSeat: disconnected.seat,
                  voterUserId: userId,
                  approveBot: approve,
                })
                .onConflictDoUpdate({
                  target: [
                    disconnectVote.roomId,
                    disconnectVote.disconnectedSeat,
                    disconnectVote.voterUserId,
                  ],
                  set: { approveBot: approve, createdAt: new Date() },
                })
              const submittedVote = {
                roomId,
                disconnectedSeat: disconnected.seat,
                voterUserId: userId,
                approveBot: approve,
                createdAt: new Date(),
              }
              const votes = [
                ...snapshot.disconnectVotes.filter((vote) => {
                  return vote.disconnectedSeat === disconnected.seat && vote.voterUserId !== userId
                }),
                submittedVote,
              ]
              snapshot.disconnectVotes = [
                ...snapshot.disconnectVotes.filter((vote) => {
                  return vote.disconnectedSeat !== disconnected.seat
                }),
                ...votes,
              ]
              if (
                eligibleVoters.length > 0 &&
                eligibleVoters.every((seat) => {
                  return votes.some((vote) => {
                    return vote.voterUserId === seat.userId && vote.approveBot
                  })
                })
              ) {
                await tx
                  .update(roomSeat)
                  .set({ controller: 'bot' })
                  .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.seat, disconnected.seat)))
                const controlledSeats = seats.map((seat) => {
                  return seat.seat === disconnected.seat
                    ? { ...seat, controller: 'bot' as const }
                    : seat
                })
                const status = controlledSeats.some((seat) => {
                  return !seat.connected && seat.controller === 'human'
                })
                  ? 'paused'
                  : statusForGame(record.game)
                const hostUserId =
                  disconnected.userId === record.hostUserId
                    ? (eligibleVoters[0]?.userId ?? record.hostUserId)
                    : record.hostUserId
                const updatedAt = new Date()
                await tx
                  .update(room)
                  .set({ status, hostUserId, version: record.version + 1, updatedAt })
                  .where(eq(room.id, roomId))
                await tx.delete(disconnectVote).where(eq(disconnectVote.roomId, roomId))
                snapshot.seats = controlledSeats
                snapshot.disconnectVotes = []
                snapshot.room = {
                  ...record,
                  status,
                  hostUserId,
                  version: record.version + 1,
                  updatedAt,
                }
              } else if (!previousVote || previousVote.approveBot !== approve) {
                const updatedAt = new Date()
                await tx
                  .update(room)
                  .set({ version: record.version + 1, updatedAt })
                  .where(eq(room.id, roomId))
                snapshot.room = { ...record, version: record.version + 1, updatedAt }
              }
              return viewFromSnapshot(userId, snapshot)
            })
          },
          catch: failure,
        })
      },
    ),
    confirmRematch: Effect.fn('GameService.confirmRematch')((userId: string, roomId: string) => {
      return Effect.tryPromise({
        try: async () => {
          const ratingSignals: string[] = []
          const result = await db.transaction(async (tx) => {
            const preflightSeats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, roomId))
              .orderBy(roomSeat.seat)
            const rematchParticipants = participantSignature(preflightSeats)
            await lockTransitionUsers(tx, seatedUserIds(preflightSeats))
            const snapshot = await loadRoomSnapshot(tx, roomId, { forUpdate: true })
            const record = snapshot?.room
            if (snapshot && participantSignature(snapshot.seats) !== rematchParticipants) {
              throw new DomainError('conflict', 'Table membership changed. Try the rematch again.')
            }
            if (
              !snapshot ||
              !record?.partyId ||
              !record.game ||
              record.game.phase !== 'match-over'
            ) {
              throw new DomainError('invalid', 'This match is not ready for a rematch.')
            }
            const seats = snapshot.seats
            const actor = seats.find((seat) => {
              return seat.userId === userId && seat.controller === 'human' && seat.connected
            })
            const humans = seats.filter((seat) => {
              return seat.userId !== null && seat.controller === 'human' && seat.connected
            })
            if (!actor) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            if (humans.length !== 2) {
              throw new DomainError('conflict', 'A partner is required for a rematch.')
            }
            await tx.insert(rematchVote).values({ roomId, userId }).onConflictDoNothing()
            const previouslyConfirmed = snapshot.rematchVotes.some((vote) => {
              return vote.userId === userId
            })
            const votes = previouslyConfirmed
              ? snapshot.rematchVotes
              : [...snapshot.rematchVotes, { roomId, userId, createdAt: new Date() }]
            snapshot.rematchVotes = votes
            if (
              humans.every((seat) => {
                return votes.some((vote) => {
                  return vote.userId === seat.userId
                })
              })
            ) {
              await rejectActiveRoomConflicts(tx, seatedUserIds(seats), roomId)
              const gameHistoryId = await recordCompletedMatch(record, record.game, seats, tx)
              if (gameHistoryId) {
                ratingSignals.push(gameHistoryId)
              }
              const game = withRatingContext(reduceGame(record.game, { type: 'new-match' }), seats)
              const matchId = crypto.randomUUID()
              const updatedAt = new Date()
              await tx.delete(rematchVote).where(eq(rematchVote.roomId, roomId))
              await tx
                .update(room)
                .set({
                  game,
                  matchId,
                  status: statusForGame(game),
                  version: record.version + 1,
                  updatedAt,
                })
                .where(eq(room.id, roomId))
              snapshot.rematchVotes = []
              snapshot.room = {
                ...record,
                game,
                matchId,
                status: statusForGame(game),
                version: record.version + 1,
                updatedAt,
              }
            } else if (!previouslyConfirmed) {
              const updatedAt = new Date()
              await tx
                .update(room)
                .set({ version: record.version + 1, updatedAt })
                .where(eq(room.id, roomId))
              snapshot.room = { ...record, version: record.version + 1, updatedAt }
            }
            return viewFromSnapshot(userId, snapshot)
          })
          await signalRatings(ratingQueue, ratingSignals)
          return result
        },
        catch: failure,
      })
    }),
    setPresence: Effect.fn('GameService.setPresence')(
      (userId: string, roomId: string, connected: boolean) => {
        return Effect.tryPromise({
          try: async () => {
            return db.transaction(async (tx) => {
              const [preflightRoom] = await tx
                .select({ status: room.status })
                .from(room)
                .where(eq(room.id, roomId))
                .limit(1)
              let presenceParticipants: string | undefined
              if (preflightRoom?.status === 'finished') {
                const preflightSeats = await tx
                  .select()
                  .from(roomSeat)
                  .where(eq(roomSeat.roomId, roomId))
                  .orderBy(roomSeat.seat)
                presenceParticipants = participantSignature(preflightSeats)
                await lockUsersAndRejectActiveRoomConflicts(
                  tx,
                  seatedUserIds(preflightSeats),
                  roomId,
                )
              }
              const snapshot = await loadRoomSnapshot(tx, roomId, { forUpdate: true })
              const record = snapshot?.room
              if (
                snapshot &&
                ((presenceParticipants !== undefined &&
                  participantSignature(snapshot.seats) !== presenceParticipants) ||
                  (preflightRoom?.status !== 'finished' && record?.status === 'finished'))
              ) {
                throw new DomainError('conflict', 'Table membership changed. Try again.')
              }
              const seat = snapshot?.seats.find((seat) => {
                return seat.userId === userId
              })
              if (!snapshot || !record || !seat) {
                throw new DomainError('forbidden', 'You are not seated at this table.')
              }
              const presenceChanged =
                seat.connected !== connected || (connected && seat.controller !== 'human')
              const presenceAt = new Date()
              await tx
                .update(roomSeat)
                .set({
                  connected,
                  controller: connected ? 'human' : seat.controller,
                  lastSeenAt: presenceAt,
                })
                .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
              if (connected) {
                await tx
                  .delete(disconnectVote)
                  .where(
                    and(
                      eq(disconnectVote.roomId, roomId),
                      eq(disconnectVote.disconnectedSeat, seat.seat),
                    ),
                  )
                snapshot.disconnectVotes = snapshot.disconnectVotes.filter((vote) => {
                  return vote.disconnectedSeat !== seat.seat
                })
              }
              const currentSeats = snapshot.seats.map((other) => {
                return other.seat === seat.seat
                  ? {
                      ...other,
                      connected,
                      controller: connected ? ('human' as const) : other.controller,
                      lastSeenAt: presenceAt,
                    }
                  : other
              })
              snapshot.seats = currentSeats
              const hasDisconnectedHuman = currentSeats.some((other) => {
                return !other.connected && other.controller === 'human'
              })
              const hostDisconnected = currentSeats.some((other) => {
                return other.controller === 'human'
                  ? other.userId === record.hostUserId && !other.connected
                  : false
              })
              const status = statusForPresence(
                record.status,
                record.game?.phase ?? null,
                hasDisconnectedHuman,
                hostDisconnected,
              )
              const game = enrollRatingParticipant(record.game, {
                ...seat,
                connected,
                controller: connected ? 'human' : seat.controller,
              })
              if (presenceChanged || status !== record.status || game !== record.game) {
                const updatedAt = new Date()
                await tx.update(room).set({ status, game, updatedAt }).where(eq(room.id, roomId))
                snapshot.room = { ...record, status, game, updatedAt }
              }
              return viewFromSnapshot(userId, snapshot)
            })
          },
          catch: failure,
        })
      },
    ),
  })

export function createGameRuntime(
  database: Database,
  ratingQueue: Pick<Queue<RatingQueueMessage>, 'send'> | undefined = env.RATING_QUEUE,
) {
  return ManagedRuntime.make(Layer.succeed(GameService, createGameService(database, ratingQueue)))
}
