import { eq, inArray, ne, and } from 'drizzle-orm'
import type { Database } from '../db/index.server'
import { activeRoomMembership, user } from '../db/schema'

type ActiveRoomDatabase = Pick<Database, 'select'>

function sortedUniqueUserIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds)].sort()
}

export async function lockActiveRoomUsers(
  database: ActiveRoomDatabase,
  userIds: readonly string[],
): Promise<string[]> {
  const sortedUserIds = sortedUniqueUserIds(userIds)
  if (sortedUserIds.length === 0) {
    return []
  }

  const locked = await database
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, sortedUserIds))
    .orderBy(user.id)
    .for('no key update', { of: user })

  return locked.map(({ id }) => {
    return id
  })
}

export async function activeRoomConflicts(
  database: ActiveRoomDatabase,
  userIds: readonly string[],
  targetRoomId?: string,
): Promise<{ roomId: string; userId: string }[]> {
  const sortedUserIds = sortedUniqueUserIds(userIds)
  if (sortedUserIds.length === 0) {
    return []
  }

  return database
    .select({ roomId: activeRoomMembership.roomId, userId: activeRoomMembership.userId })
    .from(activeRoomMembership)
    .where(
      and(
        inArray(activeRoomMembership.userId, sortedUserIds),
        targetRoomId ? ne(activeRoomMembership.roomId, targetRoomId) : undefined,
      ),
    )
    .orderBy(activeRoomMembership.userId, activeRoomMembership.roomId)
}

export async function activeRoomForUser(
  database: ActiveRoomDatabase,
  userId: string,
): Promise<{ id: string } | undefined> {
  const [activeRoom] = await database
    .select({ id: activeRoomMembership.roomId })
    .from(activeRoomMembership)
    .where(eq(activeRoomMembership.userId, userId))
    .limit(1)
  return activeRoom
}
