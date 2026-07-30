import { and, asc, eq, gt, lte, sql } from 'drizzle-orm'
import type { Database } from '../db/index.server'
import { roomWakeup } from '../db/schema'

export type RoomWakeupMessage = { roomId: string; generation: number }

export async function dispatchPendingRoomWakeups(
  database: Database,
  queue: Pick<Queue<RoomWakeupMessage>, 'send'>,
  limit = 100,
  now = new Date(),
): Promise<number> {
  const pending = await database
    .select({
      roomId: roomWakeup.roomId,
      generation: roomWakeup.generation,
    })
    .from(roomWakeup)
    .where(
      and(
        gt(roomWakeup.generation, roomWakeup.dispatchedGeneration),
        lte(roomWakeup.deadlineAt, now),
      ),
    )
    .orderBy(asc(roomWakeup.deadlineAt))
    .limit(limit)

  let dispatched = 0
  for (const wakeup of pending) {
    await queue.send(wakeup)
    dispatched += 1
  }
  return dispatched
}

export async function installRoomWakeup(
  database: Database,
  namespace: Pick<DurableObjectNamespace, 'getByName'>,
  message: RoomWakeupMessage,
): Promise<void> {
  const [current] = await database
    .select({ deadlineAt: roomWakeup.deadlineAt, generation: roomWakeup.generation })
    .from(roomWakeup)
    .where(eq(roomWakeup.roomId, message.roomId))
    .limit(1)
  if (!current || message.generation > current.generation) {
    return
  }
  const response = await namespace
    .getByName(message.roomId)
    .fetch('https://room-coordinator/wakeup', {
      method: 'POST',
      body: JSON.stringify({
        roomId: message.roomId,
        generation: current.generation,
        deadlineAt: current.deadlineAt.getTime(),
      }),
    })
  if (!response.ok) {
    throw new Error(`Room coordinator wakeup failed: ${response.status}`)
  }
  await database
    .update(roomWakeup)
    .set({
      dispatchedGeneration: sql`greatest(${roomWakeup.dispatchedGeneration}, ${current.generation})`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(roomWakeup.roomId, message.roomId), lte(roomWakeup.generation, current.generation)),
    )
}
