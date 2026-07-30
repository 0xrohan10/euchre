import {
  BOT_ACTION_MS,
  HEARTBEAT_WRITE_MS,
  STALE_PRESENCE_MS,
  TRICK_COLLECT_MS,
  type TickRoomSnapshot,
  type TickSeatSnapshot,
} from './tick-policy'

export type RoomCoordinatorMode = 'off' | 'shadow' | 'on'

export type RoomDeadline = {
  at: number
  kind: 'bot' | 'trick' | 'presence' | 'stale'
}

export function roomCoordinatorMode(value: string | undefined): RoomCoordinatorMode {
  return value === 'shadow' || value === 'on' ? value : 'off'
}

export function roomCanaryBucket(roomId: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < roomId.length; index += 1) {
    hash ^= roomId.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) % 100
}

export function shouldUseRoomCoordinator(
  roomId: string,
  mode: RoomCoordinatorMode,
  percentage: number,
): boolean {
  return mode === 'on' && roomCanaryBucket(roomId) < Math.max(0, Math.min(100, percentage))
}

export function shadowRoomCoordinator(
  roomId: string,
  mode: RoomCoordinatorMode,
  percentage: number,
): boolean {
  return mode === 'shadow' && roomCanaryBucket(roomId) < Math.max(0, Math.min(100, percentage))
}

export function roomDeadlines(
  room: TickRoomSnapshot,
  seats: readonly TickSeatSnapshot[],
  activeUserIds: ReadonlySet<string>,
  now: number,
): RoomDeadline[] {
  const deadlines: RoomDeadline[] = []
  if (activeUserIds.size > 0) {
    deadlines.push({ at: now + HEARTBEAT_WRITE_MS, kind: 'presence' })
  }
  for (const seat of seats) {
    if (
      seat.userId &&
      !activeUserIds.has(seat.userId) &&
      seat.connected &&
      seat.controller === 'human'
    ) {
      deadlines.push({ at: seat.lastSeenAtMs + STALE_PRESENCE_MS, kind: 'stale' })
    }
  }
  if (room.status !== 'playing' || !room.gamePhase) {
    return deadlines.filter((deadline) => {
      return deadline.at >= now
    })
  }
  if (room.gamePhase === 'trick-complete') {
    deadlines.push({ at: room.updatedAtMs + TRICK_COLLECT_MS, kind: 'trick' })
  } else {
    const activeSeat = seats.find((seat) => {
      return seat.seat === room.activePlayerSeat
    })
    if (activeSeat?.controller === 'bot') {
      deadlines.push({ at: room.updatedAtMs + BOT_ACTION_MS, kind: 'bot' })
    }
  }
  return deadlines
}

export function nearestRoomDeadline(deadlines: readonly RoomDeadline[]): RoomDeadline | undefined {
  return deadlines.reduce<RoomDeadline | undefined>((nearest, deadline) => {
    return !nearest || deadline.at < nearest.at ? deadline : nearest
  }, undefined)
}
