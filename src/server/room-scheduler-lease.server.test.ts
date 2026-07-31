import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/index.server'
import { acquireRoomScheduler } from './room-scheduler-lease.server'

const roomId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2800'
const ownerId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2801'

describe('room scheduler ownership', () => {
  it('returns no ownership when the opposite scheduler holds the lease', async () => {
    const execute = vi.fn(async () => {
      return { rows: [] }
    })
    const result = await acquireRoomScheduler(
      { execute } as unknown as Database,
      roomId,
      'legacy',
      ownerId,
    )

    expect(result).toBeNull()
  })

  it('returns the database epoch used across off, shadow, and on handovers', async () => {
    const execute = vi.fn(async () => {
      return {
        rows: [{ epoch: 4, expires_at: new Date('2026-07-30T12:00:15Z') }],
      }
    })

    await expect(
      acquireRoomScheduler(
        { execute } as unknown as Database,
        roomId,
        'coordinator',
        ownerId,
        new Date('2026-07-30T12:00:00Z'),
      ),
    ).resolves.toEqual({ epoch: 4, expiresAt: new Date('2026-07-30T12:00:15Z') })
  })
})
