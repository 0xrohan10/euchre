import { and, eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import type { Database } from '../db/index.server'
import { disconnectVote, roomSeat } from '../db/schema'
import type { RoomView } from '../multiplayer'
import { createGameRuntime, GameService, GameServiceError } from './game-service.server'
import { acquireRoomScheduler, type RoomSchedulerOwnership } from './room-scheduler-lease.server'
import { nearestRoomDeadline, roomDeadlines, type RoomDeadline } from './room-coordinator-policy'
import { loadRoomSnapshot, projectRoomSnapshot, type RoomSnapshot } from './room-view.server'

export type RoomReconciliation = {
  snapshot: RoomSnapshot | null
  next: RoomDeadline | undefined
  alarm: RoomDeadline | undefined
  ownership: RoomSchedulerOwnership | null
}

export async function renewActiveRoomUsers(
  database: Database,
  roomId: string,
  activeUserIds: readonly string[],
  now = new Date(),
  ownership?: { ownerId: string; epoch?: number },
): Promise<RoomSchedulerOwnership | null> {
  const users = [...new Set(activeUserIds)].sort()
  if (users.length === 0) {
    if (!ownership) {
      return null
    }
  }
  return database.transaction(async (tx) => {
    const scheduler = ownership
      ? await acquireRoomScheduler(
          tx,
          roomId,
          'coordinator',
          ownership.ownerId,
          now,
          undefined,
          ownership.epoch,
        )
      : null
    if (ownership && !scheduler) {
      return null
    }
    if (users.length === 0) {
      return scheduler
    }
    const seats = await tx
      .select({ seat: roomSeat.seat })
      .from(roomSeat)
      .where(and(eq(roomSeat.roomId, roomId), inArray(roomSeat.userId, users)))
    await tx
      .update(roomSeat)
      .set({ connected: true, controller: 'human', lastSeenAt: now })
      .where(and(eq(roomSeat.roomId, roomId), inArray(roomSeat.userId, users)))
    if (seats.length > 0) {
      await tx.delete(disconnectVote).where(
        and(
          eq(disconnectVote.roomId, roomId),
          inArray(
            disconnectVote.disconnectedSeat,
            seats.map(({ seat }) => {
              return seat
            }),
          ),
        ),
      )
    }
    return scheduler
  })
}

export function projectRoomViews(
  snapshot: RoomSnapshot | null,
  userIds: readonly string[],
): Map<string, RoomView> {
  const views = new Map<string, RoomView>()
  if (!snapshot) {
    return views
  }
  for (const userId of new Set(userIds)) {
    const view = projectRoomSnapshot(snapshot, userId)
    if (view) {
      views.set(userId, view)
    }
  }
  return views
}

export async function reconcileCoordinatedRoom(
  database: Database,
  roomId: string,
  activeUserIds: readonly string[],
  renewPresence: boolean,
  now = new Date(),
  ownership?: { ownerId: string; epoch?: number },
): Promise<RoomReconciliation> {
  const scheduler = ownership
    ? await renewActiveRoomUsers(
        database,
        roomId,
        renewPresence ? activeUserIds : [],
        now,
        ownership,
      )
    : null
  if (ownership && !scheduler) {
    return { snapshot: null, next: undefined, alarm: undefined, ownership: null }
  }

  let snapshot = await loadRoomSnapshot(database, roomId)
  const reconciliationUser = snapshot?.seats.find(({ userId }) => {
    return userId
  })?.userId
  if (reconciliationUser) {
    const runtime = createGameRuntime(database)
    try {
      await runtime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.tick(reconciliationUser, roomId, {
            heartbeat: false,
            scheduler: 'coordinator',
            schedulerOwnerId: ownership?.ownerId,
            schedulerEpoch: scheduler?.epoch ?? ownership?.epoch,
          })
        }),
      )
    } catch (error) {
      if (error instanceof GameServiceError && error.code === 'stale') {
        return { snapshot: null, next: undefined, alarm: undefined, ownership: null }
      }
      throw error
    } finally {
      await runtime.dispose()
    }
    snapshot = await loadRoomSnapshot(database, roomId)
  }
  if (!snapshot) {
    return { snapshot: null, next: undefined, alarm: undefined, ownership: scheduler }
  }

  const deadlines = roomDeadlines(
    {
      status: snapshot.room.status,
      updatedAtMs: snapshot.room.updatedAt.getTime(),
      gamePhase: snapshot.room.game?.phase ?? null,
      hostUserId: snapshot.room.hostUserId,
      activePlayerSeat: snapshot.room.game?.activePlayer ?? null,
    },
    snapshot.seats.map((seat) => {
      return {
        userId: seat.userId,
        seat: seat.seat,
        connected: seat.connected,
        controller: seat.controller,
        lastSeenAtMs: seat.lastSeenAt.getTime(),
      }
    }),
    new Set(activeUserIds),
    now.getTime(),
  )
  return {
    snapshot,
    next: nearestRoomDeadline(deadlines),
    alarm: nearestRoomDeadline(
      deadlines.filter(({ kind }) => {
        return kind !== 'presence'
      }),
    ),
    ownership: scheduler,
  }
}
