import { describe, expect, it, vi } from 'vitest'
import { scheduleRoomCoordinatorPoke } from './room-coordinator-poke.server'

describe('room coordinator poke', () => {
  it('contains a failed post-commit poke', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('coordinator unavailable')
    })
    let deferred!: Promise<void>

    scheduleRoomCoordinatorPoke(
      {
        getByName: () => {
          return { fetch }
        },
      } as unknown as Pick<DurableObjectNamespace, 'getByName'>,
      'room-1',
      (promise) => {
        deferred = promise
      },
    )

    await expect(deferred).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith('https://room-coordinator/poke', {
      method: 'POST',
      headers: { 'x-room-id': 'room-1' },
    })
  })
})
