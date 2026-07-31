import { describe, expect, it } from 'vitest'
import {
  nearestRoomDeadline,
  roomCanaryBucket,
  roomCoordinatorMode,
  roomDeadlines,
  shadowRoomCoordinator,
  shouldUseRoomCoordinator,
} from './room-coordinator-policy'
import {
  BOT_ACTION_MS,
  HEARTBEAT_WRITE_MS,
  STALE_PRESENCE_MS,
  TRICK_COLLECT_MS,
} from './tick-policy'

const now = 100_000
const room = {
  status: 'playing' as const,
  updatedAtMs: now,
  gamePhase: 'playing' as const,
  hostUserId: 'host',
  activePlayerSeat: 1,
}
const seats = [
  {
    userId: 'host',
    seat: 0,
    connected: true,
    controller: 'human' as const,
    lastSeenAtMs: now,
  },
  {
    userId: null,
    seat: 1,
    connected: true,
    controller: 'bot' as const,
    lastSeenAtMs: now,
  },
]

describe('room coordinator policy', () => {
  it('preserves exact bot, trick, presence, and stale deadlines', () => {
    expect(roomDeadlines(room, seats, new Set(['host']), now)).toContainEqual({
      kind: 'presence',
      at: now + HEARTBEAT_WRITE_MS,
    })
    expect(roomDeadlines(room, seats, new Set(['host']), now)).toContainEqual({
      kind: 'bot',
      at: now + BOT_ACTION_MS,
    })
    expect(
      roomDeadlines({ ...room, gamePhase: 'trick-complete' }, seats, new Set(['host']), now),
    ).toContainEqual({ kind: 'trick', at: now + TRICK_COLLECT_MS })
    expect(
      roomDeadlines(room, [{ ...seats[0], lastSeenAtMs: now - STALE_PRESENCE_MS }], new Set(), now),
    ).toContainEqual({ kind: 'stale', at: now })
  })

  it('chooses one nearest deadline', () => {
    expect(
      nearestRoomDeadline([
        { kind: 'presence', at: 5_000 },
        { kind: 'bot', at: 900 },
        { kind: 'trick', at: 1_600 },
      ]),
    ).toEqual({ kind: 'bot', at: 900 })
  })

  it('can select an autonomous alarm independently of an earlier presence timer', () => {
    const deadlines = [
      { kind: 'presence' as const, at: 500 },
      { kind: 'bot' as const, at: 900 },
    ]
    expect(nearestRoomDeadline(deadlines)).toEqual({ kind: 'presence', at: 500 })
    expect(
      nearestRoomDeadline(
        deadlines.filter(({ kind }) => {
          return kind !== 'presence'
        }),
      ),
    ).toEqual({ kind: 'bot', at: 900 })
  })

  it('uses stable room canaries for shadow, on, and immediate off rollback', () => {
    expect(roomCanaryBucket('room-a')).toBe(roomCanaryBucket('room-a'))
    expect(roomCoordinatorMode('invalid')).toBe('off')
    expect(shouldUseRoomCoordinator('room-a', 'off', 100)).toBe(false)
    expect(shouldUseRoomCoordinator('room-a', 'on', 100)).toBe(true)
    expect(shadowRoomCoordinator('room-a', 'shadow', 100)).toBe(true)
    expect(shadowRoomCoordinator('room-a', 'on', 100)).toBe(false)
  })
})
