import { describe, expect, it } from 'vitest'
import {
  BOT_ACTION_MS,
  evaluateTickPolicy,
  HEARTBEAT_WRITE_MS,
  STALE_PRESENCE_MS,
  TRICK_COLLECT_MS,
  type TickPolicyInput,
} from './tick-policy'

const nowMs = 1_000_000

function baseInput(overrides: Partial<TickPolicyInput> = {}): TickPolicyInput {
  return {
    nowMs,
    callerUserId: 'caller',
    room: {
      status: 'playing',
      updatedAtMs: nowMs,
      gamePhase: 'playing',
      hostUserId: 'caller',
      activePlayerSeat: 0,
    },
    seats: [
      {
        userId: 'caller',
        seat: 0,
        connected: true,
        controller: 'human',
        lastSeenAtMs: nowMs,
      },
      {
        userId: 'partner',
        seat: 2,
        connected: true,
        controller: 'human',
        lastSeenAtMs: nowMs,
      },
      {
        userId: null,
        seat: 1,
        connected: false,
        controller: 'bot',
        lastSeenAtMs: nowMs,
      },
      {
        userId: null,
        seat: 3,
        connected: false,
        controller: 'bot',
        lastSeenAtMs: nowMs,
      },
    ],
    ...overrides,
  }
}

describe('evaluateTickPolicy', () => {
  it('skips locked work for a completely idle stable room', () => {
    const policy = evaluateTickPolicy(baseInput())
    expect(policy).toEqual({
      heartbeatWriteDue: false,
      reconnectWorkDue: false,
      stalePresenceWorkDue: false,
      statusRepairDue: false,
      trickCollectionDue: false,
      botActionDue: false,
      sharedMutationMayBeNeeded: false,
    })
  })

  it('requires heartbeat write at the 5-second threshold, not before', () => {
    const before = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs - HEARTBEAT_WRITE_MS + 1,
          },
          {
            userId: 'partner',
            seat: 2,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )
    const at = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs - HEARTBEAT_WRITE_MS,
          },
          {
            userId: 'partner',
            seat: 2,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )

    expect(before.heartbeatWriteDue).toBe(false)
    expect(before.sharedMutationMayBeNeeded).toBe(false)
    expect(at.heartbeatWriteDue).toBe(true)
    expect(at.sharedMutationMayBeNeeded).toBe(true)
  })

  it('requires immediate work for disconnected or bot-controlled callers', () => {
    const disconnected = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: false,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )
    const botControlled = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'bot',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )

    expect(disconnected.reconnectWorkDue).toBe(true)
    expect(disconnected.heartbeatWriteDue).toBe(true)
    expect(disconnected.sharedMutationMayBeNeeded).toBe(true)
    expect(botControlled.reconnectWorkDue).toBe(true)
    expect(botControlled.heartbeatWriteDue).toBe(true)
    expect(botControlled.sharedMutationMayBeNeeded).toBe(true)
  })

  it('detects stale presence at the 15-second threshold, not before', () => {
    const before = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
          {
            userId: 'partner',
            seat: 2,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs - STALE_PRESENCE_MS + 1,
          },
        ],
      }),
    )
    const at = evaluateTickPolicy(
      baseInput({
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
          {
            userId: 'partner',
            seat: 2,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs - STALE_PRESENCE_MS,
          },
        ],
      }),
    )

    expect(before.stalePresenceWorkDue).toBe(false)
    expect(at.stalePresenceWorkDue).toBe(true)
    expect(at.sharedMutationMayBeNeeded).toBe(true)
  })

  it('detects trick collection at 1600ms and bot action only when active seat is a bot', () => {
    const trickBefore = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'playing',
          updatedAtMs: nowMs - TRICK_COLLECT_MS + 1,
          gamePhase: 'trick-complete',
          hostUserId: 'caller',
          activePlayerSeat: 0,
        },
      }),
    )
    const trickAt = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'playing',
          updatedAtMs: nowMs - TRICK_COLLECT_MS,
          gamePhase: 'trick-complete',
          hostUserId: 'caller',
          activePlayerSeat: 0,
        },
      }),
    )
    const humanTurnDue = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'playing',
          updatedAtMs: nowMs - BOT_ACTION_MS,
          gamePhase: 'playing',
          hostUserId: 'caller',
          activePlayerSeat: 0,
        },
      }),
    )
    const botTurnDue = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'playing',
          updatedAtMs: nowMs - BOT_ACTION_MS,
          gamePhase: 'playing',
          hostUserId: 'caller',
          activePlayerSeat: 1,
        },
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
          {
            userId: null,
            seat: 1,
            connected: false,
            controller: 'bot',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )
    const botTurnBefore = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'playing',
          updatedAtMs: nowMs - BOT_ACTION_MS + 1,
          gamePhase: 'playing',
          hostUserId: 'caller',
          activePlayerSeat: 1,
        },
        seats: [
          {
            userId: 'caller',
            seat: 0,
            connected: true,
            controller: 'human',
            lastSeenAtMs: nowMs,
          },
          {
            userId: null,
            seat: 1,
            connected: false,
            controller: 'bot',
            lastSeenAtMs: nowMs,
          },
        ],
      }),
    )

    expect(trickBefore.trickCollectionDue).toBe(false)
    expect(trickAt.trickCollectionDue).toBe(true)
    expect(humanTurnDue.botActionDue).toBe(false)
    expect(humanTurnDue.sharedMutationMayBeNeeded).toBe(false)
    expect(botTurnBefore.botActionDue).toBe(false)
    expect(botTurnDue.botActionDue).toBe(true)
    expect(botTurnDue.sharedMutationMayBeNeeded).toBe(true)
  })

  it('requires locked work when status does not match seat presence', () => {
    const policy = evaluateTickPolicy(
      baseInput({
        room: {
          status: 'paused',
          updatedAtMs: nowMs,
          gamePhase: 'playing',
          hostUserId: 'caller',
          activePlayerSeat: 0,
        },
      }),
    )

    expect(policy.statusRepairDue).toBe(true)
    expect(policy.sharedMutationMayBeNeeded).toBe(true)
  })
})
