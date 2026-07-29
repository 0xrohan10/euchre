import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireLiveAdmission, LIVE_ADMISSION_FETCH_TIMEOUT_MS } from './live-event-handlers.server'
import { LiveStreamAdmissionState } from './live-stream-admission.server'
import { createLiveSnapshotResponse } from './live-stream.server'

const decoder = new TextDecoder()

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const result = await reader.read()
  return result.value ? decoder.decode(result.value) : ''
}

describe('createLiveSnapshotResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends ready and changed snapshots but suppresses identical snapshots', async () => {
    const loadSnapshot = vi.fn(async () => {
      return { value: 1 }
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'lobby',
      loadSnapshot,
    })
    const reader = response.body!.getReader()

    expect(await readFrame(reader)).toContain('event: ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toBe(
      'event: snapshot\ndata: {"version":1,"scope":"lobby","snapshot":{"value":1}}\n\n',
    )
    await vi.advanceTimersByTimeAsync(500)
    expect(loadSnapshot).toHaveBeenCalledTimes(2)

    await reader.cancel()
  })

  it('emits a legacy room frame alongside each protocol-v1 room snapshot', async () => {
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        return { value: 1 }
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('event: snapshot')
    expect(await readFrame(reader)).toBe('event: room\ndata: {"value":1}\n\n')

    await reader.cancel()
  })

  it('heartbeats while a database read is still pending', async () => {
    const loadSnapshot = vi.fn(() => {
      return new Promise<never>(() => {})
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    expect(loadSnapshot).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await readFrame(reader)).toContain('event: degraded')
    expect(await readFrame(reader)).toContain('event: heartbeat')

    await reader.cancel()
  })

  it('degrades and retries after a transient admission outage, then recovers', async () => {
    const renewAdmission = vi
      .fn<() => Promise<'active' | 'expired' | 'replaced'>>()
      .mockRejectedValueOnce(new Error('Durable Object unavailable'))
      .mockResolvedValue('active')
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: () => {
        return new Promise<never>(() => {})
      },
      renewAdmission,
      heartbeatMs: 1_000,
      loadTimeoutMs: 60_000,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await readFrame(reader)).toContain('event: degraded')
    await vi.advanceTimersByTimeAsync(500)
    expect(await readFrame(reader)).toContain('event: heartbeat')
    expect(renewAdmission).toHaveBeenCalledTimes(2)

    await reader.cancel()
  })

  it('reconnects after confirmed admission expiry so the next stream acquires a new lease', async () => {
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: () => {
        return new Promise<never>(() => {})
      },
      renewAdmission: async () => {
        return 'expired'
      },
      heartbeatMs: 1_000,
      loadTimeoutMs: 60_000,
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await readFrame(reader)).toContain('"code":"expired","reconnect":true')
    expect((await reader.read()).done).toBe(true)
  })

  it('bounds transient admission renewal retries before the lease TTL', async () => {
    const renewAdmission = vi.fn(async () => {
      throw new Error('Durable Object unavailable')
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'lobby',
      loadSnapshot: () => {
        return new Promise<never>(() => {})
      },
      renewAdmission,
      heartbeatMs: 1_000,
      loadTimeoutMs: 60_000,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(44_999)
    const frames: string[] = []
    while (true) {
      const frame = await readFrame(reader)
      frames.push(frame)
      if (frame.includes('event: terminal')) {
        break
      }
    }

    expect(frames.join('')).toContain('"code":"expired","reconnect":true')
    expect(renewAdmission.mock.calls.length).toBeGreaterThan(1)
    expect((await reader.read()).done).toBe(true)
  })

  it('times out a never-settling snapshot load before presence can become stale', async () => {
    const loadSnapshot = vi.fn(() => {
      return new Promise<never>(() => {})
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await readFrame(reader)).toContain('event: degraded')
    await vi.advanceTimersByTimeAsync(500)
    expect(loadSnapshot).toHaveBeenCalledOnce()

    await reader.cancel()
  })

  it('does not schedule another load until a timed-out underlying promise settles', async () => {
    let pending = 0
    let maximumPending = 0
    let settle!: () => void
    const loadSnapshot = vi.fn(() => {
      pending += 1
      maximumPending = Math.max(maximumPending, pending)
      return new Promise<{ value: number }>((resolve) => {
        settle = () => {
          pending -= 1
          resolve({ value: 1 })
        }
      })
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(loadSnapshot).toHaveBeenCalledOnce()
    expect(maximumPending).toBe(1)

    await reader.cancel()
    settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(loadSnapshot).toHaveBeenCalledOnce()
    expect(maximumPending).toBe(1)
  })

  it.each(['cancel', 'abort', 'terminal', 'max-age'] as const)(
    'anchors asynchronous cleanup to the runtime on %s',
    async (reason) => {
      const abort = new AbortController()
      let finishCleanup!: () => void
      const cleanup = vi.fn(() => {
        return new Promise<void>((resolve) => {
          finishCleanup = resolve
        })
      })
      const lifetimePromises: Promise<void>[] = []
      const response = createLiveSnapshotResponse({
        request: new Request('https://example.test/events', { signal: abort.signal }),
        scope: 'lobby',
        loadSnapshot: async () => {
          if (reason === 'terminal') {
            throw { code: 'not-found' }
          }
          return { value: 1 }
        },
        classifyError: (error) => {
          return error as { code: 'not-found' }
        },
        maxLifetimeMs: 1_000,
        onCleanup: cleanup,
        waitUntil: (promise) => {
          lifetimePromises.push(promise)
        },
      })
      const reader = response.body!.getReader()
      await readFrame(reader)

      if (reason === 'cancel') {
        await reader.cancel()
      } else if (reason === 'abort') {
        abort.abort()
      } else if (reason === 'terminal') {
        await vi.advanceTimersByTimeAsync(0)
      } else {
        await vi.advanceTimersByTimeAsync(1_000)
      }

      await Promise.resolve()
      expect(cleanup).toHaveBeenCalledOnce()
      expect(lifetimePromises).toHaveLength(1)
      let completed = false
      void lifetimePromises[0].then(() => {
        completed = true
      })
      await Promise.resolve()
      expect(completed).toBe(false)

      finishCleanup()
      await lifetimePromises[0]
      expect(completed).toBe(true)
    },
  )

  it('periodically sends unchanged snapshots as authoritative progress', async () => {
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        return { value: 1 }
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('event: snapshot')
    expect(await readFrame(reader)).toContain('event: room')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await readFrame(reader)).toContain('event: snapshot')

    await reader.cancel()
  })

  it('backs transient failures off exponentially with bounded jitter', async () => {
    const loadSnapshot = vi.fn(async () => {
      throw new Error('database unavailable')
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('"attempt":1,"retryInMs":500')
    await vi.advanceTimersByTimeAsync(500)
    expect(await readFrame(reader)).toContain('"attempt":2,"retryInMs":1000')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(loadSnapshot.mock.calls.length).toBeLessThanOrEqual(7)

    await reader.cancel()
  })

  it('emits terminal errors and cleans up exactly once', async () => {
    const cleanup = vi.fn()
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        throw { code: 'not-found' }
      },
      classifyError: (error) => {
        return error as { code: 'not-found' }
      },
      onCleanup: cleanup,
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toBe(
      'event: terminal\ndata: {"version":1,"code":"not-found","reconnect":false}\n\n',
    )
    expect(await readFrame(reader)).toContain('event: gone')
    expect((await reader.read()).done).toBe(true)
    await reader.cancel()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('terminates an admission replacement without inviting a reconnect', async () => {
    const cleanup = vi.fn()
    let replace = () => {}
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: () => {
        return new Promise<never>(() => {})
      },
      onCleanup: cleanup,
      registerCleanup: (_cleanup, replaceConnection) => {
        replace = replaceConnection
        return () => {}
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    replace()

    expect(await readFrame(reader)).toContain('"code":"replaced","reconnect":false')
    expect((await reader.read()).done).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('waits for pending database work and confirmed release before refreshing', async () => {
    const abort = new AbortController()
    const cleanup = vi.fn()
    const releaseAdmission = vi.fn()
    const lifetimePromises: Promise<void>[] = []
    let settleLoad!: () => void
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events', { signal: abort.signal }),
      scope: 'lobby',
      loadSnapshot: () => {
        return new Promise<{ value: number }>((resolve) => {
          settleLoad = () => {
            resolve({ value: 1 })
          }
        })
      },
      maxLifetimeMs: 1_000,
      onCleanup: cleanup,
      releaseAdmissionOnce: releaseAdmission,
      waitUntil: (promise) => {
        lifetimePromises.push(promise)
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cleanup).not.toHaveBeenCalled()
    expect(releaseAdmission).not.toHaveBeenCalled()
    expect(lifetimePromises).toHaveLength(0)
    settleLoad()
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('event: snapshot')
    expect(await readFrame(reader)).toContain('"code":"refresh","reconnect":true')
    abort.abort()
    await reader.cancel()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(releaseAdmission).toHaveBeenCalledOnce()
    expect(lifetimePromises).toHaveLength(1)
    await lifetimePromises[0]
    expect(cleanup).toHaveBeenCalledOnce()
    expect(releaseAdmission).toHaveBeenCalledOnce()
  })

  it('does not start a poll that becomes due while refresh release is in flight', async () => {
    let finishRelease!: () => void
    const loadSnapshot = vi.fn(async () => {
      return { value: 1 }
    })
    const releaseAdmission = vi.fn(() => {
      return new Promise<void>((resolve) => {
        finishRelease = resolve
      })
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'lobby',
      loadSnapshot,
      releaseAdmissionOnce: releaseAdmission,
      maxLifetimeMs: 1_000,
      pollIntervalMs: 1_500,
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    await readFrame(reader)
    expect(loadSnapshot).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(releaseAdmission).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(loadSnapshot).toHaveBeenCalledOnce()

    finishRelease()
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('"code":"refresh"')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(loadSnapshot).toHaveBeenCalledOnce()
  })

  it('resumes a presence poll before retrying a failed refresh release', async () => {
    let failRelease!: (error: Error) => void
    const calls: string[] = []
    const loadSnapshot = vi.fn(async () => {
      calls.push('load')
      return { value: 1 }
    })
    const releaseAdmission = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        calls.push('release')
        return new Promise<void>((_resolve, reject) => {
          failRelease = reject
        })
      })
      .mockImplementationOnce(async () => {
        calls.push('release')
      })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
      releaseAdmissionOnce: releaseAdmission,
      maxLifetimeMs: 1_000,
      pollIntervalMs: 500,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(500)
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(releaseAdmission).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(500)
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    failRelease(new Error('admission unavailable'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await readFrame(reader)).toContain('event: snapshot')
    expect(await readFrame(reader)).toContain('event: room')
    expect(await readFrame(reader)).toContain('event: degraded')

    await vi.advanceTimersByTimeAsync(499)
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(loadSnapshot).toHaveBeenCalledTimes(3)
    expect(releaseAdmission).toHaveBeenCalledTimes(2)
    expect(calls.slice(-2)).toEqual(['load', 'release'])
    expect(await readFrame(reader)).toContain('"code":"refresh"')
  })

  it('keeps the old stream degraded and retries release after an outage', async () => {
    const releaseAdmission = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('admission unavailable'))
      .mockResolvedValue()
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        return { value: 1 }
      },
      releaseAdmissionOnce: releaseAdmission,
      maxLifetimeMs: 1_000,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()

    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(0)
    await readFrame(reader)
    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await readFrame(reader)).toContain('event: degraded')
    expect(releaseAdmission).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(500)
    const terminal = await readFrame(reader)
    expect(terminal).toContain('"code":"refresh"')
    expect(releaseAdmission).toHaveBeenCalledTimes(2)
  })

  it('keeps serialized room ticks and lease renewal active through a release outage over 15 seconds', async () => {
    let pendingLoads = 0
    let maximumPendingLoads = 0
    let lastPresenceRenewal = Date.now()
    let admissionAvailable = false
    const loadSnapshot = vi.fn(async () => {
      pendingLoads += 1
      maximumPendingLoads = Math.max(maximumPendingLoads, pendingLoads)
      lastPresenceRenewal = Date.now()
      pendingLoads -= 1
      return { connected: Date.now() - lastPresenceRenewal < 15_000 }
    })
    const releaseAdmission = vi.fn(async () => {
      if (!admissionAvailable) {
        throw new Error('admission unavailable')
      }
    })
    const renewAdmission = vi.fn(async () => {
      return 'active' as const
    })
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot,
      releaseAdmissionOnce: releaseAdmission,
      renewAdmission,
      heartbeatMs: 1_000,
      maxLifetimeMs: 1_000,
      maxRetryMs: 3_000,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()
    await readFrame(reader)

    await vi.advanceTimersByTimeAsync(17_000)
    expect(loadSnapshot.mock.calls.length).toBeGreaterThan(20)
    expect(loadSnapshot.mock.calls.length).toBeLessThanOrEqual(36)
    expect(maximumPendingLoads).toBe(1)
    expect(Date.now() - lastPresenceRenewal).toBeLessThan(15_000)
    expect(renewAdmission.mock.calls.length).toBeGreaterThan(15)

    admissionAvailable = true
    await vi.advanceTimersByTimeAsync(3_000)
    const frames: string[] = []
    while (true) {
      const frame = await readFrame(reader)
      frames.push(frame)
      if (frame.includes('event: terminal')) {
        break
      }
    }
    expect(frames.join('')).toContain('"connected":true')
    expect(frames.at(-1)).toContain('"code":"refresh"')
  })

  it('keeps room progress below watchdog and presence limits through repeated release timeouts', async () => {
    const startedAt = Date.now()
    const releaseSignals: AbortSignal[] = []
    const releaseAttemptTimes: number[] = []
    const releaseAbortTimes: number[] = []
    const fetchAdmission = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) {
        throw new Error('missing admission abort signal')
      }
      const body = JSON.parse(String(init.body)) as { leaseId: string }
      if (String(input).endsWith('/acquire')) {
        return Promise.resolve(Response.json({ active: true, leaseId: body.leaseId }))
      }
      releaseSignals.push(signal)
      releaseAttemptTimes.push(Date.now())
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            releaseAbortTimes.push(Date.now())
            reject(signal.reason)
          },
          { once: true },
        )
      })
    })
    const admission = await acquireLiveAdmission(fetchAdmission, 'room', crypto.randomUUID())
    const tickTimes: number[] = []
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        tickTimes.push(Date.now())
        return { connected: true }
      },
      releaseAdmissionOnce: admission!.releaseOnce,
      maxLifetimeMs: 1_000,
      timers: {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        now: Date.now,
        random: () => {
          return 0.5
        },
      },
    })
    const reader = response.body!.getReader()
    await readFrame(reader)
    const snapshotTimes: number[] = []
    const collectFrames = (async () => {
      while (true) {
        const frame = await readFrame(reader)
        if (!frame) {
          return
        }
        if (frame.includes('event: snapshot')) {
          snapshotTimes.push(Date.now())
        }
      }
    })()

    await vi.advanceTimersByTimeAsync(20_000)

    const snapshotGaps = snapshotTimes.slice(1).map((time, index) => {
      return time - snapshotTimes[index]
    })
    const tickGaps = tickTimes.slice(1).map((time, index) => {
      return time - tickTimes[index]
    })
    expect(
      releaseAttemptTimes.map((time) => {
        return time - startedAt
      }),
    ).toEqual([1_000, 3_500, 6_500, 10_500, 16_500])
    expect(
      releaseAbortTimes.map((time, index) => {
        return time - releaseAttemptTimes[index]
      }),
    ).toEqual(
      Array.from({ length: releaseAttemptTimes.length }, () => {
        return 2_000
      }),
    )
    expect(releaseSignals).toHaveLength(releaseAttemptTimes.length)
    expect(
      releaseSignals.every((signal) => {
        return signal.aborted
      }),
    ).toBe(true)
    expect(
      Math.max(
        ...releaseAbortTimes.map((abortTime) => {
          return (
            abortTime -
            snapshotTimes.findLast((snapshotTime) => {
              return snapshotTime <= abortTime
            })!
          )
        }),
      ),
    ).toBeLessThan(12_000)
    expect(Math.max(...snapshotGaps, Date.now() - snapshotTimes.at(-1)!)).toBeLessThan(12_000)
    expect(Math.max(...tickGaps, Date.now() - tickTimes.at(-1)!)).toBeLessThan(15_000)

    await reader.cancel()
    await collectFrames
    expect(vi.getTimerCount()).toBe(0)
    expect(LIVE_ADMISSION_FETCH_TIMEOUT_MS).toBe(2_000)
  })

  it('frees the admission slot before a lost refresh terminal reconnects', async () => {
    const pageId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2833'
    const oldLeaseId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2834'
    const newLeaseId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2835'
    const admission = new LiveStreamAdmissionState()
    admission.acquire('room', pageId, oldLeaseId, 0)
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events'),
      scope: 'room',
      loadSnapshot: async () => {
        return { value: 1 }
      },
      releaseAdmissionOnce: async () => {
        admission.release(oldLeaseId, Date.now())
      },
      maxLifetimeMs: 1_000,
    })
    const reader = response.body!.getReader()
    await readFrame(reader)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(admission.acquire('room', pageId, newLeaseId, Date.now())).toEqual({
      active: true,
      replaced: [],
    })

    // The browser loses the terminal frame and follows the normal EventSource close path.
    await reader.cancel()
    expect(
      admission.leases.map(({ leaseId }) => {
        return leaseId
      }),
    ).toEqual([newLeaseId])
  })

  it('releases a legacy stream at max lifetime and closes without a terminal frame', async () => {
    const releaseAdmission = vi.fn(async () => {})
    const response = createLiveSnapshotResponse({
      request: new Request('https://example.test/events?stream=legacy'),
      scope: 'room',
      loadSnapshot: async () => {
        return { value: 1 }
      },
      releaseAdmissionOnce: releaseAdmission,
      legacyMaxLifetime: true,
      maxLifetimeMs: 1_000,
    })
    const reader = response.body!.getReader()
    const frames = [await readFrame(reader)]
    await vi.advanceTimersByTimeAsync(1_000)
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      frames.push(decoder.decode(result.value))
    }

    expect(frames.join('')).not.toContain('event: terminal')
    expect(releaseAdmission).toHaveBeenCalledOnce()
  })
})
