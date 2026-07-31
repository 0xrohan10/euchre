import { describe, expect, it } from 'vitest'
import {
  LIVE_ADMISSION_MAX_LEASES,
  LIVE_ADMISSION_TTL_MS,
  LiveStreamAdmissionState,
  handleLiveStreamAdmissionRequest,
} from './live-stream-admission.server'

const ids = Array.from({ length: 12 }, (_, index) => {
  return `0198fd3c-5ef0-7a08-9fd1-16dd758b28${String(index).padStart(2, '0')}`
})

class MemoryAdmissionStorage {
  readonly values = new Map<string, unknown>()
  alarm: number | null = null

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value))
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null
  }
}

function admissionRequest(action: 'acquire' | 'renew' | 'release', body: object) {
  return new Request(`https://admission.test/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('LiveStreamAdmissionState', () => {
  it('bounds a flood to three leases per scope', () => {
    const state = new LiveStreamAdmissionState()
    const results = ids.slice(0, 6).map((pageId, index) => {
      return state.acquire('room', pageId, ids[index + 1], index)
    })

    expect(
      state.leases.filter(({ scope }) => {
        return scope === 'room'
      }),
    ).toHaveLength(LIVE_ADMISSION_MAX_LEASES)
    expect(
      results.filter(({ active }) => {
        return !active
      }),
    ).toHaveLength(3)
  })

  it('retains superseded same-page leases until release or expiry', () => {
    const state = new LiveStreamAdmissionState()
    state.acquire('room', ids[0], ids[3], 0)
    state.acquire('room', ids[1], ids[4], 1)

    expect(state.acquire('room', ids[0], ids[5], 2)).toEqual({
      active: true,
      replaced: [ids[3]],
    })
    expect(state.leases).toHaveLength(3)
    expect(state.renew(ids[3], 3)).toBe('replaced')
    expect(state.renew(ids[4], 3)).toBe('active')
    expect(state.renew(ids[5], 3)).toBe('active')
    expect(state.acquire('room', ids[0], ids[6], 4)).toEqual({
      active: false,
      replaced: [],
    })

    state.release(ids[3], 5)
    expect(state.acquire('room', ids[0], ids[6], 6)).toEqual({
      active: true,
      replaced: [ids[5]],
    })
  })

  it('expires abandoned leases by TTL', () => {
    const state = new LiveStreamAdmissionState()
    state.acquire('lobby', ids[0], ids[1], 100)

    state.prune(100 + LIVE_ADMISSION_TTL_MS)

    expect(state.leases).toHaveLength(0)
  })
})

describe('live stream admission Durable Object API', () => {
  it('coordinates floods through shared storage across isolate callers', async () => {
    const storage = new MemoryAdmissionStorage()
    const responses = []
    for (let index = 0; index < 4; index += 1) {
      responses.push(
        await handleLiveStreamAdmissionRequest(
          storage,
          admissionRequest('acquire', {
            scope: 'room',
            pageId: ids[index],
            leaseId: ids[index + 4],
          }),
          index,
        ),
      )
    }

    expect(responses[3].status).toBe(429)
    await expect(responses[3].json()).resolves.toEqual({ active: false, replaced: [] })
    const firstLease = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('renew', { leaseId: ids[4] }),
      5,
    )
    await expect(firstLease.json()).resolves.toEqual({ status: 'active' })
  })

  it('denies a same-page reconnect at capacity without hiding the current lease', async () => {
    const storage = new MemoryAdmissionStorage()
    for (let index = 0; index < 3; index += 1) {
      await handleLiveStreamAdmissionRequest(
        storage,
        admissionRequest('acquire', {
          scope: 'room',
          pageId: ids[index],
          leaseId: ids[index + 3],
        }),
        index,
      )
    }

    const reconnect = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('acquire', { scope: 'room', pageId: ids[0], leaseId: ids[7] }),
      4,
    )
    expect(reconnect.status).toBe(429)
    await expect(reconnect.json()).resolves.toEqual({ active: false, replaced: [] })
    const current = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('renew', { leaseId: ids[3] }),
      5,
    )
    expect(current.status).toBe(200)
    await expect(current.json()).resolves.toEqual({ status: 'active' })
  })

  it('does not let a repeated client operation replay or bypass admission', async () => {
    const storage = new MemoryAdmissionStorage()
    const responses = []
    for (let index = 0; index < 4; index += 1) {
      responses.push(
        await handleLiveStreamAdmissionRequest(
          storage,
          admissionRequest('acquire', {
            scope: 'room',
            pageId: ids[0],
            leaseId: ids[index + 3],
            operationId: ids[10],
          }),
          index,
        ),
      )
    }

    await expect(responses[0].json()).resolves.toMatchObject({ leaseId: ids[3] })
    await expect(responses[1].json()).resolves.toMatchObject({ leaseId: ids[4] })
    expect(
      responses.map(({ status }) => {
        return status
      }),
    ).toEqual([200, 200, 200, 429])
    expect(storage.values.get('leases')).toHaveLength(LIVE_ADMISSION_MAX_LEASES)
  })

  it('bounds a high-concurrency same-page flood across simulated isolates', async () => {
    const storage = new MemoryAdmissionStorage()
    let serialized = Promise.resolve()
    const fromIsolate = (leaseId: string, now: number) => {
      const response = serialized.then(() => {
        return handleLiveStreamAdmissionRequest(
          storage,
          admissionRequest('acquire', { scope: 'room', pageId: ids[0], leaseId }),
          now,
        )
      })
      serialized = response.then(() => {})
      return response
    }

    const responses = await Promise.all(
      ids.slice(1, 11).map((leaseId, index) => {
        return fromIsolate(leaseId, index)
      }),
    )

    expect(
      responses.filter((response) => {
        return response.status === 200
      }),
    ).toHaveLength(LIVE_ADMISSION_MAX_LEASES)
    expect(
      responses.filter((response) => {
        return response.status === 429
      }),
    ).toHaveLength(7)

    const first = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('renew', { leaseId: ids[1] }),
      11,
    )
    expect(first.status).toBe(409)
    await expect(first.json()).resolves.toEqual({ status: 'replaced' })

    await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('release', { leaseId: ids[1] }),
      12,
    )
    const overlapRecovered = await fromIsolate(ids[11], 13)
    expect(overlapRecovered.status).toBe(200)
  })

  it('releases on cleanup and removes expired leases', async () => {
    const storage = new MemoryAdmissionStorage()
    await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('acquire', { scope: 'lobby', pageId: ids[0], leaseId: ids[1] }),
      10,
    )
    await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('release', { leaseId: ids[1] }),
      11,
    )
    const released = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('renew', { leaseId: ids[1] }),
      12,
    )
    expect(released.status).toBe(404)
    await expect(released.json()).resolves.toEqual({ status: 'expired' })

    await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('acquire', { scope: 'lobby', pageId: ids[0], leaseId: ids[2] }),
      20,
    )
    const expired = await handleLiveStreamAdmissionRequest(
      storage,
      admissionRequest('renew', { leaseId: ids[2] }),
      20 + LIVE_ADMISSION_TTL_MS,
    )
    expect(expired.status).toBe(404)
    await expect(expired.json()).resolves.toEqual({ status: 'expired' })
  })
})
