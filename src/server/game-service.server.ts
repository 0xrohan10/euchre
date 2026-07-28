import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'
import { db } from '../db/index.server'
import {
  disconnectVote,
  gameHistory,
  gameHistoryParticipant,
  party,
  partyMember,
  rematchVote,
  room,
  roomCommand,
  roomSeat,
  user,
} from '../db/schema'
import { createGame } from '../game/deal'
import type { Player } from '../game/player'
import type { GameHistorySeat, GameHistorySummary } from '../game/history'
import { reduceGame } from '../game/reduce'
import type { GameRules } from '../game/rules'
import type { GameAction, GameState } from '../game/state'
import {
  acceptsRoomAction,
  advanceBot,
  eligibleBotVoters,
  projectGame,
  statusForGame,
  statusForPresence,
  type PartyView,
  type PlayerAction,
  type RoomView,
  type SeatView,
} from '../multiplayer'
import { evaluateTickPolicy } from './tick-policy'

export class GameServiceError extends Data.TaggedError('GameServiceError')<{
  readonly code: 'not-found' | 'forbidden' | 'conflict' | 'invalid' | 'database'
  readonly message: string
}> {}

type SubmitCommand = {
  roomId: string
  commandId: string
  expectedVersion: number
  action: PlayerAction | { type: 'next-hand' } | { type: 'new-match' }
}

type GameServiceShape = {
  createRoom: (userId: string, rules: GameRules) => Effect.Effect<RoomView, GameServiceError>
  createSinglePlayerRoom: (
    userId: string,
    rules: GameRules,
  ) => Effect.Effect<RoomView, GameServiceError>
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
  tick: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
  history: (userId: string) => Effect.Effect<GameHistorySummary[], GameServiceError>
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

type RoomReader = Pick<typeof db, 'select'>
type HistoryWriter = Pick<typeof db, 'insert' | 'select'>

async function recordCompletedMatch(
  record: typeof room.$inferSelect,
  game: GameState,
  seats: (typeof roomSeat.$inferSelect)[],
  database: HistoryWriter = db,
) {
  if (game.phase !== 'match-over') {
    return
  }
  const userIds = seats.flatMap((seat) => {
    return seat.userId ? [seat.userId] : []
  })
  const players =
    userIds.length > 0
      ? await database
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, userIds))
      : []
  const names = new Map(
    players.map((player) => {
      return [player.id, player.name]
    }),
  )
  const historySeats: GameHistorySeat[] = seats.map((seat) => {
    return {
      seat: seat.seat,
      userId: seat.userId,
      name: (seat.userId && names.get(seat.userId)) || `Bot ${seat.seat}`,
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
  if (created && userIds.length > 0) {
    await database.insert(gameHistoryParticipant).values(
      userIds.map((userId) => {
        return { gameHistoryId: created.id, userId }
      }),
    )
  }
}

async function viewParty(userId: string, database: RoomReader = db): Promise<PartyView | null> {
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

async function viewRoom(
  userId: string,
  roomId: string,
  database: RoomReader = db,
): Promise<RoomView> {
  const [record] = await database.select().from(room).where(eq(room.id, roomId)).limit(1)
  if (!record) {
    throw new DomainError('not-found', 'Table not found.')
  }

  const seatRows = await database
    .select({
      seat: roomSeat.seat,
      userId: roomSeat.userId,
      name: user.name,
      controller: roomSeat.controller,
      connected: roomSeat.connected,
    })
    .from(roomSeat)
    .leftJoin(user, eq(roomSeat.userId, user.id))
    .where(eq(roomSeat.roomId, roomId))
    .orderBy(roomSeat.seat)
  const viewer = seatRows.find((seat) => {
    return seat.userId === userId
  })
  if (!viewer) {
    throw new DomainError('forbidden', 'You are not seated at this table.')
  }

  const votes = await database
    .select({
      disconnectedSeat: disconnectVote.disconnectedSeat,
      voterUserId: disconnectVote.voterUserId,
      approveBot: disconnectVote.approveBot,
    })
    .from(disconnectVote)
    .where(eq(disconnectVote.roomId, roomId))
  const disconnectedSeat =
    record.status === 'paused'
      ? (votes[0]?.disconnectedSeat ??
        seatRows.find((seat) => {
          return !seat.connected && seat.controller === 'human'
        })?.seat)
      : undefined
  const eligibleVoters =
    disconnectedSeat === undefined
      ? []
      : eligibleBotVoters(seatRows as SeatView[], disconnectedSeat as Player)
  const rematchVotes =
    record.partyId && record.game?.phase === 'match-over'
      ? await database
          .select({ userId: rematchVote.userId })
          .from(rematchVote)
          .where(eq(rematchVote.roomId, roomId))
      : []
  const humanSeats = seatRows.filter((seat) => {
    return seat.userId !== null
  })
  return {
    id: record.id,
    code: record.code,
    status: record.status,
    version: record.version,
    hostUserId: record.hostUserId,
    partyId: record.partyId,
    viewerSeat: viewer.seat as Player,
    rules: record.rules,
    seats: seatRows.map((seat) => {
      return {
        ...seat,
        name: seat.name ?? `Bot ${seat.seat}`,
      }
    }) as SeatView[],
    game: record.game ? projectGame(record.game, viewer.seat as Player) : null,
    disconnectVote:
      disconnectedSeat === undefined
        ? null
        : {
            disconnectedSeat: disconnectedSeat as Player,
            approvals: votes
              .filter((vote) => {
                return (
                  vote.approveBot &&
                  eligibleVoters.some((seat) => {
                    return seat.userId === vote.voterUserId
                  })
                )
              })
              .flatMap((vote) => {
                const voter = seatRows.find((seat) => {
                  return seat.userId === vote.voterUserId
                })
                return voter ? [voter.seat as Player] : []
              }),
            requiredApprovals: eligibleVoters.length,
          },
    rematch:
      record.partyId && record.game?.phase === 'match-over'
        ? {
            confirmations: humanSeats
              .filter((seat) => {
                return rematchVotes.some((vote) => {
                  return vote.userId === seat.userId
                })
              })
              .map((seat) => {
                return seat.seat as Player
              }),
            requiredConfirmations: 2,
          }
        : null,
  }
}

const GameServiceLive = Layer.succeed(
  GameService,
  GameService.of({
    history: Effect.fn('GameService.history')((userId: string) => {
      return Effect.tryPromise({
        try: async () => {
          const records = await db
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
        },
        catch: failure,
      })
    }),
    tick: Effect.fn('GameService.tick')((userId: string, roomId: string) => {
      return Effect.tryPromise({
        try: async () => {
          const toPolicyInput = (
            nowMs: number,
            record: typeof room.$inferSelect,
            seats: (typeof roomSeat.$inferSelect)[],
          ) => {
            return {
              nowMs,
              callerUserId: userId,
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
          const preflight = await db.transaction(async (tx) => {
            await tx.execute(sql`set local transaction isolation level repeatable read`)
            const now = new Date()
            const [preflightRoom] = await tx.select().from(room).where(eq(room.id, roomId)).limit(1)
            if (!preflightRoom) {
              throw new DomainError('not-found', 'Table not found.')
            }
            const preflightSeats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, roomId))
              .orderBy(roomSeat.seat)
            const preflightCaller = preflightSeats.find((seat) => {
              return seat.userId === userId
            })
            if (!preflightCaller) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            const preflightPolicy = evaluateTickPolicy(
              toPolicyInput(now.getTime(), preflightRoom, preflightSeats),
            )
            if (!preflightPolicy.sharedMutationMayBeNeeded) {
              return { kind: 'view' as const, view: await viewRoom(userId, roomId, tx) }
            }
            return { kind: 'mutate' as const }
          })
          if (preflight.kind === 'view') {
            return preflight.view
          }

          return db.transaction(async (tx) => {
            const lockedNow = new Date()
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, roomId))
              .for('update')
              .limit(1)
            if (!record) {
              throw new DomainError('not-found', 'Table not found.')
            }
            const seats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, roomId))
              .orderBy(roomSeat.seat)
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
              return viewRoom(userId, roomId, tx)
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
                seat.userId !== userId &&
                seat.connected &&
                seat.controller === 'human' &&
                lockedNow.getTime() - seat.lastSeenAt.getTime() >= 15_000
              )
            })
            if (staleSeats.length > 0) {
              for (const seat of staleSeats) {
                await tx
                  .update(roomSeat)
                  .set({ connected: false })
                  .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.seat, seat.seat)))
              }
            }
            const currentSeats = renewedSeats.map((seat) => {
              return staleSeats.some((stale) => {
                return stale.seat === seat.seat
              })
                ? { ...seat, connected: false }
                : seat
            })
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
              lockedPolicy.statusRepairDue
            ) {
              await tx.update(room).set({ status, updatedAt: lockedNow }).where(eq(room.id, roomId))
            }
            if (staleSeats.length === 0 && record.game && status === 'playing') {
              const elapsed = lockedNow.getTime() - record.updatedAt.getTime()
              const game =
                record.game.phase === 'trick-complete'
                  ? elapsed >= 1_600
                    ? reduceGame(record.game, { type: 'collect-trick' })
                    : record.game
                  : elapsed >= 900
                    ? advanceBot(record.game, currentSeats)
                    : record.game
              if (game !== record.game) {
                await recordCompletedMatch(record, game, currentSeats, tx)
                await tx
                  .update(room)
                  .set({
                    game,
                    status: statusForGame(game),
                    version: record.version + 1,
                    updatedAt: lockedNow,
                  })
                  .where(eq(room.id, roomId))
              }
            }
            return viewRoom(userId, roomId, tx)
          })
        },
        catch: failure,
      })
    }),
    currentRoom: Effect.fn('GameService.currentRoom')((userId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [seat] = await tx
              .select({ roomId: roomSeat.roomId })
              .from(roomSeat)
              .innerJoin(room, eq(roomSeat.roomId, room.id))
              .where(eq(roomSeat.userId, userId))
              .orderBy(desc(room.updatedAt))
              .limit(1)
            return seat ? viewRoom(userId, seat.roomId, tx) : null
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
            const [seat] = await tx
              .select({ roomId: roomSeat.roomId })
              .from(roomSeat)
              .innerJoin(room, eq(roomSeat.roomId, room.id))
              .where(eq(roomSeat.userId, userId))
              .orderBy(desc(room.updatedAt))
              .limit(1)
            return seat ? viewRoom(userId, seat.roomId, tx) : null
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
            const existing = await viewParty(userId, tx)
            if (existing) {
              if (existing.inviteCode === inviteCode) {
                return existing
              }
              throw new DomainError(
                'conflict',
                'Leave your current partnership before joining another.',
              )
            }
            const [record] = await tx
              .select()
              .from(party)
              .where(eq(party.inviteCode, inviteCode))
              .for('update')
              .limit(1)
            if (!record) {
              throw new DomainError('not-found', 'Partner invite not found.')
            }
            const members = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, record.id))
            if (members.length >= 2) {
              throw new DomainError('conflict', 'This partner invite has already been used.')
            }
            await tx.insert(partyMember).values({ partyId: record.id, userId })
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
              .for('update')
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
              .for('update')
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
                            statusForGame(activeRoom.game),
                            activeRoom.game.phase,
                            hasDisconnectedHuman,
                            false,
                          ),
                    version: activeRoom.version + 1,
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
              .for('update')
              .limit(1)
            if (!record || record.ownerUserId !== userId) {
              throw new DomainError('forbidden', 'Only the party creator can start a match.')
            }
            const members = await tx
              .select()
              .from(partyMember)
              .where(eq(partyMember.partyId, record.id))
              .orderBy(partyMember.joinedAt)
            if (members.length !== 2) {
              throw new DomainError('conflict', 'Invite a partner before starting a match.')
            }
            const [activeRoom] = await tx
              .select()
              .from(room)
              .where(and(eq(room.partyId, record.id), inArray(room.status, ['playing', 'paused'])))
              .orderBy(desc(room.updatedAt))
              .limit(1)
            if (activeRoom) {
              return viewRoom(userId, activeRoom.id, tx)
            }
            const game = createGame(undefined, rules)
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
            const partner = members.find((member) => {
              return member.userId !== userId
            })!
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
    createRoom: Effect.fn('GameService.createRoom')((userId: string, rules: GameRules) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [created] = await tx
              .insert(room)
              .values({ code: randomCode(), hostUserId: userId, rules })
              .returning()
            await tx
              .insert(roomSeat)
              .values({ roomId: created.id, seat: 0, userId, connected: true })
            return viewRoom(userId, created.id, tx)
          })
        },
        catch: failure,
      })
    }),
    createSinglePlayerRoom: Effect.fn('GameService.createSinglePlayerRoom')(
      (userId: string, rules: GameRules) => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              const game = createGame(undefined, rules)
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
              return viewRoom(userId, created.id, tx)
            })
          },
          catch: failure,
        })
      },
    ),
    joinRoom: Effect.fn('GameService.joinRoom')((userId: string, code: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.code, code.toUpperCase()))
              .for('update')
              .limit(1)
            if (!record) {
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
                  game: createGame(undefined, record.rules),
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
          await db.transaction(async (tx) => {
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, roomId))
              .for('update')
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
              await recordCompletedMatch(record, record.game, seats, tx)
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
        try: () => {
          return db.transaction(async (tx) => {
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, command.roomId))
              .for('update')
              .limit(1)
            if (!record?.game) {
              throw new DomainError('not-found', 'Active game not found.')
            }
            const seats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, command.roomId))
              .orderBy(roomSeat.seat)
            const actor = seats.find((seat) => {
              return seat.userId === userId
            })
            if (!actor) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            const [duplicate] = await tx
              .select()
              .from(roomCommand)
              .where(
                and(
                  eq(roomCommand.roomId, command.roomId),
                  eq(roomCommand.commandId, command.commandId),
                ),
              )
              .limit(1)
            if (duplicate) {
              return viewRoom(userId, command.roomId, tx)
            }
            if (!acceptsRoomAction(record.status, record.game.phase, command.action.type)) {
              throw new DomainError(
                'conflict',
                'That action is not available in the current game state.',
              )
            }
            if (record.version !== command.expectedVersion) {
              throw new DomainError('conflict', 'Your game view is stale.')
            }
            if (actor.controller !== 'human') {
              throw new DomainError('forbidden', 'This seat is currently controlled by a bot.')
            }
            const hostAction =
              command.action.type === 'next-hand' || command.action.type === 'new-match'
            if (record.partyId && command.action.type === 'new-match') {
              throw new DomainError('invalid', 'Both partners must confirm a rematch.')
            }
            if (hostAction && record.hostUserId !== userId) {
              throw new DomainError('forbidden', 'Only the host can advance the match.')
            }
            if (!hostAction && record.game.activePlayer !== actor.seat) {
              throw new DomainError('forbidden', 'It is not your turn.')
            }
            const reduced = reduceGame(record.game, command.action as GameAction)
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
            await recordCompletedMatch(record, reduced, seats, tx)
            await tx.insert(roomCommand).values({
              roomId: command.roomId,
              commandId: command.commandId,
              userId,
              action: command.action as GameAction,
            })
            await tx
              .update(room)
              .set({
                game: reduced,
                status,
                matchId: command.action.type === 'new-match' ? crypto.randomUUID() : record.matchId,
                version: record.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(room.id, command.roomId))
            return viewRoom(userId, command.roomId, tx)
          })
        },
        catch: failure,
      })
    }),
    voteForBot: Effect.fn('GameService.voteForBot')(
      (userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => {
        return Effect.tryPromise({
          try: () => {
            return db.transaction(async (tx) => {
              const [record] = await tx
                .select()
                .from(room)
                .where(eq(room.id, roomId))
                .for('update')
                .limit(1)
              const seats = await tx
                .select()
                .from(roomSeat)
                .where(eq(roomSeat.roomId, roomId))
                .orderBy(roomSeat.seat)
              const voter = seats.find((seat) => {
                return seat.userId === userId
              })
              const disconnected = seats.find((seat) => {
                return (
                  seat.seat === disconnectedSeat && !seat.connected && seat.controller === 'human'
                )
              })
              if (
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
              const [previousVote] = await tx
                .select()
                .from(disconnectVote)
                .where(
                  and(
                    eq(disconnectVote.roomId, roomId),
                    eq(disconnectVote.disconnectedSeat, disconnected.seat),
                    eq(disconnectVote.voterUserId, userId),
                  ),
                )
                .limit(1)
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
              const votes = await tx
                .select()
                .from(disconnectVote)
                .where(
                  and(
                    eq(disconnectVote.roomId, roomId),
                    eq(disconnectVote.disconnectedSeat, disconnected.seat),
                  ),
                )
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
                await tx
                  .update(room)
                  .set({ status, hostUserId, version: record.version + 1, updatedAt: new Date() })
                  .where(eq(room.id, roomId))
                await tx.delete(disconnectVote).where(eq(disconnectVote.roomId, roomId))
              } else if (!previousVote || previousVote.approveBot !== approve) {
                await tx
                  .update(room)
                  .set({ version: record.version + 1, updatedAt: new Date() })
                  .where(eq(room.id, roomId))
              }
              return viewRoom(userId, roomId, tx)
            })
          },
          catch: failure,
        })
      },
    ),
    confirmRematch: Effect.fn('GameService.confirmRematch')((userId: string, roomId: string) => {
      return Effect.tryPromise({
        try: () => {
          return db.transaction(async (tx) => {
            const [record] = await tx
              .select()
              .from(room)
              .where(eq(room.id, roomId))
              .for('update')
              .limit(1)
            if (!record?.partyId || !record.game || record.game.phase !== 'match-over') {
              throw new DomainError('invalid', 'This match is not ready for a rematch.')
            }
            const seats = await tx
              .select()
              .from(roomSeat)
              .where(eq(roomSeat.roomId, roomId))
              .orderBy(roomSeat.seat)
            const actor = seats.find((seat) => {
              return seat.userId === userId && seat.controller === 'human'
            })
            const humans = seats.filter((seat) => {
              return seat.userId !== null
            })
            if (!actor) {
              throw new DomainError('forbidden', 'You are not seated at this table.')
            }
            if (humans.length !== 2) {
              throw new DomainError('conflict', 'A partner is required for a rematch.')
            }
            await tx.insert(rematchVote).values({ roomId, userId }).onConflictDoNothing()
            const votes = await tx.select().from(rematchVote).where(eq(rematchVote.roomId, roomId))
            if (
              humans.every((seat) => {
                return votes.some((vote) => {
                  return vote.userId === seat.userId
                })
              })
            ) {
              await recordCompletedMatch(record, record.game, seats, tx)
              const game = reduceGame(record.game, { type: 'new-match' })
              await tx.delete(rematchVote).where(eq(rematchVote.roomId, roomId))
              await tx
                .update(room)
                .set({
                  game,
                  matchId: crypto.randomUUID(),
                  status: statusForGame(game),
                  version: record.version + 1,
                  updatedAt: new Date(),
                })
                .where(eq(room.id, roomId))
            } else {
              await tx
                .update(room)
                .set({ version: record.version + 1, updatedAt: new Date() })
                .where(eq(room.id, roomId))
            }
            return viewRoom(userId, roomId, tx)
          })
        },
        catch: failure,
      })
    }),
    setPresence: Effect.fn('GameService.setPresence')(
      (userId: string, roomId: string, connected: boolean) => {
        return Effect.tryPromise({
          try: async () => {
            return db.transaction(async (tx) => {
              const [record] = await tx
                .select()
                .from(room)
                .where(eq(room.id, roomId))
                .for('update')
                .limit(1)
              const [seat] = await tx
                .select()
                .from(roomSeat)
                .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
                .limit(1)
              if (!record || !seat) {
                throw new DomainError('forbidden', 'You are not seated at this table.')
              }
              const presenceChanged =
                seat.connected !== connected || (connected && seat.controller !== 'human')
              await tx
                .update(roomSeat)
                .set({
                  connected,
                  controller: connected ? 'human' : seat.controller,
                  lastSeenAt: new Date(),
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
              }
              const disconnectedSeats = await tx
                .select()
                .from(roomSeat)
                .where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.connected, false)))
              const hasDisconnectedHuman = disconnectedSeats.some((other) => {
                return other.controller === 'human'
              })
              const hostDisconnected = disconnectedSeats.some((other) => {
                return other.userId === record.hostUserId && other.controller === 'human'
              })
              const status = statusForPresence(
                record.status,
                record.game?.phase ?? null,
                hasDisconnectedHuman,
                hostDisconnected,
              )
              if (presenceChanged || status !== record.status) {
                await tx
                  .update(room)
                  .set({ status, updatedAt: new Date() })
                  .where(eq(room.id, roomId))
              }
              return viewRoom(userId, roomId, tx)
            })
          },
          catch: failure,
        })
      },
    ),
  }),
)

export const gameRuntime = ManagedRuntime.make(GameServiceLive)
