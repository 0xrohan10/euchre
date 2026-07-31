/* eslint-disable arrow-body-style */
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/index.server'
import { dispatchPendingRoomWakeups, installRoomWakeup } from './room-wakeup.server'

const roomId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2800'

function dispatchDatabase(pending: Array<{ roomId: string; generation: number }>) {
  const mark = vi.fn(async () => {})
  return {
    database: {
      select: () => {
        return {
          from: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => pending }) }),
          }),
        }
      },
      update: () => {
        return { set: () => ({ where: mark }) }
      },
    } as unknown as Database,
    mark,
  }
}

describe('room wakeup outbox', () => {
  it('retains committed outbox work when queue send fails', async () => {
    const { database, mark } = dispatchDatabase([{ roomId, generation: 3 }])
    const queue = {
      send: vi.fn(async () => {
        return Promise.reject(new Error('queue unavailable'))
      }),
    } as unknown as Pick<Queue<{ roomId: string; generation: number }>, 'send'>

    await expect(dispatchPendingRoomWakeups(database, queue)).rejects.toThrow('queue unavailable')
    expect(mark).not.toHaveBeenCalled()
  })

  it('does not mark a generation merely because queue send succeeds', async () => {
    const { database, mark } = dispatchDatabase([{ roomId, generation: 3 }])
    const send = vi.fn(async () => {
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }
    })
    const queue = { send }

    await expect(dispatchPendingRoomWakeups(database, queue)).resolves.toBe(1)
    expect(send).toHaveBeenCalledWith({ roomId, generation: 3 })
    expect(mark).not.toHaveBeenCalled()
  })

  it('makes duplicate and out-of-order deliveries install the current database deadline', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    const mark = vi.fn(async () => {})
    const database = {
      select: () => {
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ generation: 5, deadlineAt: new Date(1234) }],
            }),
          }),
        }
      },
      update: () => {
        return { set: () => ({ where: mark }) }
      },
    } as unknown as Database
    const namespace = {
      getByName: () => {
        return { fetch }
      },
    } as unknown as Pick<DurableObjectNamespace, 'getByName'>

    await installRoomWakeup(database, namespace, { roomId, generation: 3 })
    await installRoomWakeup(database, namespace, { roomId, generation: 3 })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(mark).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      roomId,
      generation: 5,
      deadlineAt: 1234,
    })
  })

  it('throws on Durable Object failure so the queue delivery retries', async () => {
    const mark = vi.fn(async () => {})
    const database = {
      select: () => {
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ generation: 1, deadlineAt: new Date() }],
            }),
          }),
        }
      },
      update: () => {
        return { set: () => ({ where: mark }) }
      },
    } as unknown as Database
    const namespace = {
      getByName: () => {
        return { fetch: async () => new Response(null, { status: 503 }) }
      },
    } as unknown as Pick<DurableObjectNamespace, 'getByName'>

    await expect(installRoomWakeup(database, namespace, { roomId, generation: 1 })).rejects.toThrow(
      '503',
    )
    expect(mark).not.toHaveBeenCalled()
  })
})
