import { statusForPresence, type RoomStatus } from '../multiplayer'
import type { GameState } from '../game/state'

export const HEARTBEAT_WRITE_MS = 5_000
export const STALE_PRESENCE_MS = 15_000
export const TRICK_COLLECT_MS = 1_600
export const BOT_ACTION_MS = 900

export type TickSeatSnapshot = {
  userId: string | null
  seat: number
  connected: boolean
  controller: 'human' | 'bot'
  lastSeenAtMs: number
}

export type TickRoomSnapshot = {
  status: RoomStatus
  updatedAtMs: number
  gamePhase: GameState['phase'] | null
  hostUserId: string
  activePlayerSeat: number | null
}

export type TickPolicyInput = {
  nowMs: number
  callerUserId: string
  heartbeatEnabled?: boolean
  room: TickRoomSnapshot
  seats: TickSeatSnapshot[]
}

export type TickPolicy = {
  heartbeatWriteDue: boolean
  reconnectWorkDue: boolean
  stalePresenceWorkDue: boolean
  statusRepairDue: boolean
  trickCollectionDue: boolean
  botActionDue: boolean
  sharedMutationMayBeNeeded: boolean
}

function callerSeat(input: TickPolicyInput): TickSeatSnapshot | undefined {
  return input.seats.find((seat) => {
    return seat.userId === input.callerUserId
  })
}

export function evaluateTickPolicy(input: TickPolicyInput): TickPolicy {
  const caller = callerSeat(input)
  const heartbeatEnabled = input.heartbeatEnabled !== false
  const reconnectWorkDue = Boolean(
    heartbeatEnabled && caller && (!caller.connected || caller.controller !== 'human'),
  )
  const heartbeatWriteDue = Boolean(
    heartbeatEnabled &&
    caller &&
    (reconnectWorkDue || input.nowMs - caller.lastSeenAtMs >= HEARTBEAT_WRITE_MS),
  )
  const stalePresenceWorkDue = input.seats.some((seat) => {
    return (
      (!heartbeatEnabled || seat.userId !== input.callerUserId) &&
      seat.connected &&
      seat.controller === 'human' &&
      input.nowMs - seat.lastSeenAtMs >= STALE_PRESENCE_MS
    )
  })
  const hasDisconnectedHuman = input.seats.some((seat) => {
    return !seat.connected && seat.controller === 'human'
  })
  const hostDisconnected = input.seats.some((seat) => {
    return seat.userId === input.room.hostUserId && !seat.connected && seat.controller === 'human'
  })
  const desiredStatus = statusForPresence(
    input.room.status,
    input.room.gamePhase,
    hasDisconnectedHuman,
    hostDisconnected,
  )
  const statusRepairDue = desiredStatus !== input.room.status

  const elapsed = input.nowMs - input.room.updatedAtMs
  const timersEligible = Boolean(input.room.gamePhase) && input.room.status === 'playing'
  const trickCollectionDue =
    timersEligible && input.room.gamePhase === 'trick-complete' && elapsed >= TRICK_COLLECT_MS
  const activeSeat =
    input.room.activePlayerSeat === null
      ? undefined
      : input.seats.find((seat) => {
          return seat.seat === input.room.activePlayerSeat
        })
  const botActionDue =
    timersEligible &&
    input.room.gamePhase !== 'trick-complete' &&
    elapsed >= BOT_ACTION_MS &&
    activeSeat?.controller === 'bot'

  return {
    heartbeatWriteDue,
    reconnectWorkDue,
    stalePresenceWorkDue,
    statusRepairDue,
    trickCollectionDue,
    botActionDue,
    sharedMutationMayBeNeeded:
      heartbeatWriteDue ||
      reconnectWorkDue ||
      stalePresenceWorkDue ||
      statusRepairDue ||
      trickCollectionDue ||
      botActionDue,
  }
}
