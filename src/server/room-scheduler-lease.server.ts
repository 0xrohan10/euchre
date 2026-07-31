import { sql } from 'drizzle-orm'
import type { Database } from '../db/index.server'

export type RoomSchedulerMode = 'legacy' | 'coordinator'
export type RoomSchedulerOwnership = { epoch: number; expiresAt: Date }
type SchedulerDatabase = Pick<Database, 'execute'>

export async function acquireRoomScheduler(
  database: SchedulerDatabase,
  roomId: string,
  mode: RoomSchedulerMode,
  ownerId: string,
  now = new Date(),
  ttlMs = 15_000,
  expectedEpoch?: number,
): Promise<RoomSchedulerOwnership | null> {
  const expiresAt = new Date(now.getTime() + ttlMs)
  const requiredEpoch = expectedEpoch ?? null
  const result = await database.execute<{ epoch: number; expires_at: Date }>(sql`
    insert into room_scheduler_lease (room_id, mode, owner_id, epoch, expires_at, updated_at)
    values (${roomId}, ${mode}, ${ownerId}, 1, ${expiresAt}, ${now})
    on conflict (room_id) do update set
      mode = excluded.mode,
      owner_id = excluded.owner_id,
      epoch = case
        when room_scheduler_lease.mode = excluded.mode
         and room_scheduler_lease.owner_id = excluded.owner_id
        then room_scheduler_lease.epoch
        else room_scheduler_lease.epoch + 1
      end,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    where (${requiredEpoch}::bigint is null or room_scheduler_lease.epoch = ${requiredEpoch})
      and (
        room_scheduler_lease.expires_at <= ${now}
        or (
          room_scheduler_lease.mode = excluded.mode
          and room_scheduler_lease.owner_id = excluded.owner_id
        )
      )
    returning epoch, expires_at
  `)
  const row = result.rows[0]
  return row ? { epoch: Number(row.epoch), expiresAt: new Date(row.expires_at) } : null
}
