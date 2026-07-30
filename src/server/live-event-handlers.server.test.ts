import { Effect, Layer, ManagedRuntime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeck } from '../game/card'
import { createGame } from '../game/deal'
import { projectGame, type RoomView } from '../multiplayer'
import {
  acquireLiveAdmission,
  createLiveEventHandlers,
  createManagedLiveConnection,
  createLiveStreamRegistry,
  LIVE_ADMISSION_FETCH_TIMEOUT_MS,
  LIVE_STREAMS_PER_USER_SCOPE,
  parseLiveAdmissionRenewal,
  releaseLiveAdmission,
} from './live-event-handlers.server'

const decoder = new TextDecoder()
const PAGE_A = '0198fd3c-5ef0-7a08-9fd1-16dd758b2833'
const PAGE_B = '0198fd3c-5ef0-7a08-9fd1-16dd758b2834'
const PAGES = Array.from({ length: 5 }, (_, index) => {
  return `0198fd3c-5ef0-7a08-9fd1-16dd758b28${String(33 + index).padStart(2, '0')}`
})

function roomFor(userId: string, viewerSeat: 0 | 1): RoomView {
  return {
    id: 'room-1',
    code: 'TABLE1',
    status: 'playing',
    version: 1,
    hostUserId: 'user-a',
    partyId: null,
    viewerSeat,
    rules: {
      stickDealer: true,
      requireNaturalTrump: false,
      allowAloneWhenOrderingPartner: false,
      allowFarmersHand: false,
    },
    seats: [
      {
        seat: viewerSeat,
        userId,
        name: userId,
        controller: 'human',
        connected: true,
        rating: 1_000,
        ratingGames: 0,
        ratingMode: 'competitive',
      },
    ],
    game: projectGame(createGame(createDeck()), viewerSeat),
    disconnectVote: null,
    rematch: null,
  }
}

async function readSnapshot(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  await reader.read()
  await vi.advanceTimersByTimeAsync(0)
  const snapshot = await reader.read()
  await reader.cancel()
  return decoder.decode(snapshot.value)
}

describe('live event handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('authenticates before opening an SSE body', async () => {
    const openLobby = vi.fn()
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return null
      },
      userId: (context: string) => {
        return context
      },
      openLobby,
      openRoom: vi.fn(),
    })

    const response = await handlers.lobby(new Request('https://example.test/api/lobby/events'))

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).not.toBe('text/event-stream')
    expect(openLobby).not.toHaveBeenCalled()
  })

  it('derives lobby identity only from the authenticated session', async () => {
    const loadSnapshot = vi.fn(async () => {
      return { party: null, room: null }
    })
    const openLobby = vi.fn(() => {
      return { loadSnapshot, dispose: vi.fn() }
    })
    const release = vi.fn(async () => {})
    const acquireAdmission = vi.fn(async () => {
      return {
        renew: async () => {
          return 'active' as const
        },
        releaseOnce: release,
        release,
      }
    })
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby,
      openRoom: vi.fn(),
      acquireAdmission,
    })

    const response = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?userId=attacker&page=${PAGE_A}`),
    )
    const frame = await readSnapshot(response)

    expect(openLobby).toHaveBeenCalledWith('session-user')
    expect(acquireAdmission).toHaveBeenCalledWith('session-user', 'lobby', PAGE_A)
    expect(frame).toContain('"scope":"lobby"')
    expect(frame).not.toContain('attacker')
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects an invalid page identity before opening stream resources', async () => {
    const openLobby = vi.fn()
    const acquireAdmission = vi.fn()
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby,
      openRoom: vi.fn(),
      acquireAdmission,
    })

    const response = await handlers.lobby(
      new Request('https://example.test/api/lobby/events?page=attacker-controlled'),
    )

    expect(response.status).toBe(400)
    expect(acquireAdmission).not.toHaveBeenCalled()
    expect(openLobby).not.toHaveBeenCalled()
  })

  it('rejects random room identifiers before admission or Durable Object work', async () => {
    const acquireAdmission = vi.fn()
    const openRoom = vi.fn()
    const authorizeRoom = vi.fn()
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom,
      acquireAdmission,
      authorizeRoom,
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/random/events?page=${PAGE_A}`),
      'random',
    )

    expect(response.status).toBe(400)
    expect(authorizeRoom).not.toHaveBeenCalled()
    expect(acquireAdmission).not.toHaveBeenCalled()
    expect(openRoom).not.toHaveBeenCalled()
  })

  it('checks authenticated seat membership before admission', async () => {
    const acquireAdmission = vi.fn()
    const openRoom = vi.fn()
    const roomId = '0198fd3c-5ef0-7a08-9fd1-16dd758b2800'
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom,
      acquireAdmission,
      authorizeRoom: async () => {
        return false
      },
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/${roomId}/events?page=${PAGE_A}`),
      roomId,
    )

    expect(response.status).toBe(404)
    expect(acquireAdmission).not.toHaveBeenCalled()
    expect(openRoom).not.toHaveBeenCalled()
  })

  it('does not open stream resources when the global gate is full', async () => {
    const openLobby = vi.fn()
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby,
      openRoom: vi.fn(),
      acquireAdmission: async () => {
        return null
      },
    })

    const response = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGE_A}`),
    )

    expect(response.status).toBe(429)
    expect(openLobby).not.toHaveBeenCalled()
  })

  it('detects an old stream-query client and closes it at max age without a terminal', async () => {
    const release = vi.fn(async () => {})
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom: () => {
        return {
          loadSnapshot: async () => {
            return roomFor('session-user', 0)
          },
          dispose: vi.fn(),
        }
      },
      acquireAdmission: async () => {
        return {
          renew: async () => {
            return 'active' as const
          },
          releaseOnce: release,
          release,
        }
      },
    })
    const response = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?stream=${PAGE_A}`),
      'room-1',
    )
    const reader = response.body!.getReader()
    const frames = [decoder.decode((await reader.read()).value)]

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }
      frames.push(decoder.decode(result.value))
    }

    expect(frames.join('')).not.toContain('event: terminal')
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps admission release alive after the response body is cancelled', async () => {
    let finishLoad!: () => void
    let finishRelease!: () => void
    const release = vi.fn(() => {
      return new Promise<void>((resolve) => {
        finishRelease = resolve
      })
    })
    const lifetimePromises: Promise<void>[] = []
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: () => {
        return {
          loadSnapshot: () => {
            return new Promise<{ party: null; room: null }>((resolve) => {
              finishLoad = () => {
                resolve({ party: null, room: null })
              }
            })
          },
          dispose: vi.fn(),
        }
      },
      openRoom: vi.fn(),
      acquireAdmission: async () => {
        return {
          renew: async () => {
            return 'active' as const
          },
          releaseOnce: release,
          release,
        }
      },
      waitUntil: (promise) => {
        lifetimePromises.push(promise)
      },
    })
    const response = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGE_A}`),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await vi.advanceTimersByTimeAsync(0)

    await reader.cancel()

    expect(release).not.toHaveBeenCalled()
    expect(lifetimePromises).toHaveLength(1)
    finishLoad()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    finishRelease()
    await Promise.all(lifetimePromises)
  })

  it('keeps cancelled database work admitted until its underlying promise settles', async () => {
    const leases = new Set<string>()
    const settleLoads: Array<() => void> = []
    const lifetimePromises: Promise<void>[] = []
    let pendingLoads = 0
    let maximumPendingLoads = 0
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: () => {
        return {
          loadSnapshot: () => {
            pendingLoads += 1
            maximumPendingLoads = Math.max(maximumPendingLoads, pendingLoads)
            return new Promise<{ party: null; room: null }>((resolve) => {
              settleLoads.push(() => {
                pendingLoads -= 1
                resolve({ party: null, room: null })
              })
            })
          },
          dispose: vi.fn(),
        }
      },
      openRoom: vi.fn(),
      acquireAdmission: async (_context, _scope, pageId) => {
        if (leases.size >= LIVE_STREAMS_PER_USER_SCOPE) {
          return null
        }
        leases.add(pageId)
        return {
          renew: async () => {
            return 'active' as const
          },
          releaseOnce: async () => {
            leases.delete(pageId)
          },
          release: async () => {
            leases.delete(pageId)
          },
        }
      },
      waitUntil: (promise) => {
        lifetimePromises.push(promise)
      },
    })

    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = []
    for (const pageId of PAGES.slice(0, 3)) {
      const response = await handlers.lobby(
        new Request(`https://example.test/api/lobby/events?page=${pageId}`),
      )
      const reader = response.body!.getReader()
      readers.push(reader)
      await reader.read()
      await vi.advanceTimersByTimeAsync(0)
      await reader.cancel()
    }

    expect(pendingLoads).toBe(3)
    expect(leases.size).toBe(3)
    const denied = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGES[3]}`),
    )
    expect(denied.status).toBe(429)

    settleLoads[0]()
    await lifetimePromises[0]
    expect(pendingLoads).toBe(2)
    expect(leases.size).toBe(2)

    const admitted = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGES[3]}`),
    )
    expect(admitted.status).toBe(200)
    const admittedReader = admitted.body!.getReader()
    await admittedReader.read()
    await vi.advanceTimersByTimeAsync(0)
    expect(pendingLoads).toBe(3)
    expect(maximumPendingLoads).toBe(3)

    await admittedReader.cancel()
    for (const settle of settleLoads.slice(1)) {
      settle()
    }
    await Promise.all(lifetimePromises)
  })

  it('keeps admission until an abort-insensitive ManagedRuntime promise actually settles', async () => {
    let settleUnderlying!: () => void
    const underlying = new Promise<{ party: null; room: null }>((resolve) => {
      settleUnderlying = () => {
        resolve({ party: null, room: null })
      }
    })
    const runtime = ManagedRuntime.make(Layer.empty)
    const dispose = vi.spyOn(runtime, 'dispose')
    const release = vi.fn(async () => {})
    const lifetimePromises: Promise<void>[] = []
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: () => {
        return createManagedLiveConnection(runtime, () => {
          return Effect.tryPromise({
            try: () => {
              return underlying
            },
            catch: (error) => {
              return error
            },
          })
        })
      },
      openRoom: vi.fn(),
      acquireAdmission: async () => {
        return {
          renew: async () => {
            return 'active' as const
          },
          releaseOnce: release,
          release,
        }
      },
      waitUntil: (promise) => {
        lifetimePromises.push(promise)
      },
    })
    const response = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGE_A}`),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await vi.advanceTimersByTimeAsync(0)

    await reader.cancel()

    expect(lifetimePromises).toHaveLength(1)
    expect(dispose).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    settleUnderlying()
    await lifetimePromises[0]

    expect(dispose).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('refreshes lobby snapshots every two seconds', async () => {
    const loadSnapshot = vi.fn(async () => {
      return { party: null, room: null }
    })
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: () => {
        return { loadSnapshot, dispose: vi.fn() }
      },
      openRoom: vi.fn(),
    })
    const response = await handlers.lobby(
      new Request(`https://example.test/api/lobby/events?page=${PAGE_A}`),
    )
    const reader = response.body!.getReader()
    await reader.read()
    await vi.advanceTimersByTimeAsync(0)
    await reader.read()

    await vi.advanceTimersByTimeAsync(1_999)
    expect(loadSnapshot).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(loadSnapshot).toHaveBeenCalledTimes(2)

    await reader.cancel()
  })

  it('keeps room projections separate and seat-redacted per authenticated viewer', async () => {
    const handlers = createLiveEventHandlers({
      authenticate: async (request) => {
        return request.headers.get('x-user')
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom: (userId, _roomId) => {
        return {
          loadSnapshot: async () => {
            return roomFor(userId, userId === 'user-a' ? 0 : 1)
          },
          dispose: vi.fn(),
        }
      },
    })
    const first = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?page=${PAGE_A}`, {
        headers: { 'x-user': 'user-a' },
      }),
      'room-1',
    )
    const second = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?page=${PAGE_B}`, {
        headers: { 'x-user': 'user-b' },
      }),
      'room-1',
    )

    const [firstFrame, secondFrame] = await Promise.all([readSnapshot(first), readSnapshot(second)])

    expect(firstFrame).toContain('"viewerSeat":0')
    expect(secondFrame).toContain('"viewerSeat":1')
    expect(firstFrame).not.toBe(secondFrame)
    for (const privateField of ['hands', 'kitty', 'initialHands', 'ratingParticipants']) {
      expect(firstFrame).not.toContain(`"${privateField}"`)
      expect(secondFrame).not.toContain(`"${privateField}"`)
    }
  })

  it('uses a returned admission capability for read-only selected-room fallback', async () => {
    const renew = vi.fn(async () => {
      return 'active' as const
    })
    const release = vi.fn(async () => {})
    const openRoom = vi.fn()
    const openRoomReadOnly = vi.fn(() => {
      return {
        loadSnapshot: async () => {
          return roomFor('session-user', 0)
        },
        dispose: vi.fn(),
      }
    })
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom,
      openRoomReadOnly,
      acquireAdmission: async () => {
        return { leaseId: PAGE_A, renew, releaseOnce: release, release }
      },
      roomCoordinatorSelection: () => {
        return 'coordinator'
      },
      connectRoomCoordinator: async () => {
        return new Response(null, {
          status: 503,
          headers: { 'x-room-coordinator-admission': 'returned' },
        })
      },
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?page=${PAGE_A}`),
      'room-1',
    )
    const reader = response.body!.getReader()
    const frames = [decoder.decode((await reader.read()).value)]
    await vi.advanceTimersByTimeAsync(0)
    frames.push(decoder.decode((await reader.read()).value))
    frames.push(decoder.decode((await reader.read()).value))
    frames.push(decoder.decode((await reader.read()).value))
    await vi.advanceTimersByTimeAsync(0)

    expect(openRoom).not.toHaveBeenCalled()
    expect(openRoomReadOnly).toHaveBeenCalledOnce()
    expect(frames.join('')).toContain('"code":"refresh"')
    expect(renew).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('acquires a fresh lease when the coordinator releases a failed transfer', async () => {
    const oldRelease = vi.fn(async () => {})
    const freshRenew = vi.fn(async () => {
      return 'active' as const
    })
    const freshRelease = vi.fn(async () => {})
    const acquireAdmission = vi
      .fn()
      .mockResolvedValueOnce({
        leaseId: PAGE_A,
        renew: vi.fn(),
        releaseOnce: oldRelease,
        release: oldRelease,
      })
      .mockResolvedValueOnce({
        leaseId: PAGE_B,
        renew: freshRenew,
        releaseOnce: freshRelease,
        release: freshRelease,
      })
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom: vi.fn(),
      openRoomReadOnly: () => {
        return {
          loadSnapshot: async () => {
            return roomFor('session-user', 0)
          },
          dispose: vi.fn(),
        }
      },
      acquireAdmission,
      roomCoordinatorSelection: () => {
        return 'coordinator'
      },
      connectRoomCoordinator: async () => {
        return new Response(null, {
          status: 503,
          headers: { 'x-room-coordinator-admission': 'released' },
        })
      },
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?page=${PAGE_A}`),
      'room-1',
    )
    await response.body!.cancel()
    await vi.advanceTimersByTimeAsync(0)

    expect(acquireAdmission).toHaveBeenCalledTimes(2)
    expect(oldRelease).not.toHaveBeenCalled()
    expect(freshRelease).toHaveBeenCalledOnce()
  })

  it('returns retry instead of opening a legacy scheduler during ownership contention', async () => {
    const openRoom = vi.fn()
    const openRoomReadOnly = vi.fn()
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom,
      openRoomReadOnly,
      acquireAdmission: async () => {
        return {
          leaseId: PAGE_A,
          renew: vi.fn(),
          releaseOnce: vi.fn(),
          release: vi.fn(),
        }
      },
      roomCoordinatorSelection: () => {
        return 'coordinator'
      },
      connectRoomCoordinator: async () => {
        return new Response(null, {
          status: 503,
          headers: { 'x-room-coordinator-retry': 'ownership', 'Retry-After': '1' },
        })
      },
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?page=${PAGE_A}`),
      'room-1',
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(openRoom).not.toHaveBeenCalled()
    expect(openRoomReadOnly).not.toHaveBeenCalled()
  })

  it.each([
    ['rollback off', 'legacy', `page=${PAGE_A}`],
    ['mixed-version selected room', 'coordinator', `stream=${PAGE_A}`],
  ] as const)('keeps %s on the legacy scheduler', async (_label, selection, query) => {
    const openRoom = vi.fn(() => {
      return {
        loadSnapshot: async () => {
          return roomFor('session-user', 0)
        },
        dispose: vi.fn(),
      }
    })
    const handlers = createLiveEventHandlers({
      authenticate: async () => {
        return 'session-user'
      },
      userId: (context: string) => {
        return context
      },
      openLobby: vi.fn(),
      openRoom,
      openRoomReadOnly: vi.fn(),
      roomCoordinatorSelection: () => {
        return selection
      },
    })

    const response = await handlers.room(
      new Request(`https://example.test/api/tables/room-1/events?${query}`),
      'room-1',
    )
    const reader = response.body!.getReader()
    await reader.read()
    await vi.advanceTimersByTimeAsync(0)
    await reader.cancel()

    expect(openRoom).toHaveBeenCalledOnce()
  })
})

describe('live admission renewal responses', () => {
  it('distinguishes active, expired, and replaced leases', async () => {
    await expect(parseLiveAdmissionRenewal(Response.json({ status: 'active' }))).resolves.toBe(
      'active',
    )
    await expect(parseLiveAdmissionRenewal(new Response(null, { status: 404 }))).resolves.toBe(
      'expired',
    )
    await expect(parseLiveAdmissionRenewal(new Response(null, { status: 409 }))).resolves.toBe(
      'replaced',
    )
  })

  it('keeps transient and malformed renewal failures retryable by throwing', async () => {
    await expect(parseLiveAdmissionRenewal(new Response(null, { status: 503 }))).rejects.toThrow(
      'renewal failed',
    )
    await expect(parseLiveAdmissionRenewal(Response.json({ active: true }))).rejects.toThrow(
      'Invalid live stream admission renewal response',
    )
  })
})

describe('live admission release', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requires 2xx and retries 500 and thrown failures before succeeding', async () => {
    const responses: Array<Response | Error> = [
      new Response(null, { status: 500 }),
      new Error('transport failed'),
      new Response(null, { status: 204 }),
    ]
    const invoke = vi.fn(async () => {
      const response = responses.shift()
      if (response instanceof Error) {
        throw response
      }
      return response!
    })
    const sleep = vi.fn(async () => {})

    await releaseLiveAdmission(invoke, PAGE_A, sleep)

    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke.mock.calls).toEqual([
      ['release', { leaseId: PAGE_A }],
      ['release', { leaseId: PAGE_A }],
      ['release', { leaseId: PAGE_A }],
    ])
    expect(sleep.mock.calls).toEqual([[100], [200]])
  })

  it('stops after bounded release retries and leaves TTL as the fallback', async () => {
    const invoke = vi.fn(async () => {
      return new Response(null, { status: 503 })
    })
    const sleep = vi.fn(async () => {})

    await expect(releaseLiveAdmission(invoke, PAGE_A, sleep)).rejects.toThrow(
      'admission release failed',
    )

    expect(invoke).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls).toEqual([[100], [200], [400]])
  })

  it('aborts every never-settling release fetch before retrying and succeeding', async () => {
    const signals: AbortSignal[] = []
    let releaseAttempt = 0
    const fetchAdmission = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) {
        throw new Error('missing admission abort signal')
      }
      const body = JSON.parse(String(init.body)) as { leaseId: string; scope?: string }
      if (body.scope) {
        return Promise.resolve(Response.json({ active: true, leaseId: body.leaseId }))
      }
      releaseAttempt += 1
      if (releaseAttempt === 4) {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true },
        )
      })
    })
    const admission = await acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)

    const release = admission!.release()
    await vi.advanceTimersByTimeAsync(LIVE_ADMISSION_FETCH_TIMEOUT_MS * 3 + 700)
    await expect(release).resolves.toBeUndefined()

    expect(signals).toHaveLength(3)
    expect(
      signals.every((signal) => {
        return signal.aborted
      }),
    ).toBe(true)
    expect(releaseAttempt).toBe(4)
  })

  it('aborts and exhausts every never-settling release retry', async () => {
    const signals: AbortSignal[] = []
    const fetchAdmission = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) {
        throw new Error('missing admission abort signal')
      }
      const body = JSON.parse(String(init.body)) as { leaseId: string; scope?: string }
      if (body.scope) {
        return Promise.resolve(Response.json({ active: true, leaseId: body.leaseId }))
      }
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true },
        )
      })
    })
    const admission = await acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)

    const release = admission!.release()
    const rejection = expect(release).rejects.toThrow('admission release failed')
    await vi.advanceTimersByTimeAsync(LIVE_ADMISSION_FETCH_TIMEOUT_MS * 4 + 700)
    await rejection

    expect(signals).toHaveLength(4)
    expect(
      signals.every((signal) => {
        return signal.aborted
      }),
    ).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('live admission fetch deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function neverSettlingFetch(signals: AbortSignal[]) {
    return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      if (!signal) {
        throw new Error('missing admission abort signal')
      }
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason)
          },
          { once: true },
        )
      })
    })
  }

  it('uses a fresh server lease for each acquire request', async () => {
    const requests: Array<{ leaseId: string; pageId: string }> = []
    const fetchAdmission = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { leaseId: string; pageId: string }
      requests.push(body)
      return Response.json({ active: true, leaseId: body.leaseId })
    })

    await acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)
    await acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)

    expect(
      requests.map(({ pageId }) => {
        return pageId
      }),
    ).toEqual([PAGE_A, PAGE_A])
    expect(
      new Set(
        requests.map(({ leaseId }) => {
          return leaseId
        }),
      ).size,
    ).toBe(2)
  })

  it('keeps a lost acquire response counted until request cleanup releases it', async () => {
    const leases = new Set<string>()
    let countedDuringResponseLoss = false
    const fetchAdmission = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { leaseId: string; scope?: string }
      if (String(input).endsWith('/acquire')) {
        leases.add(body.leaseId)
        countedDuringResponseLoss = leases.size === 1
        throw new Error('response lost after commit')
      }
      if (String(input).endsWith('/release')) {
        leases.delete(body.leaseId)
        return new Response(null, { status: 204 })
      }
      throw new Error('unexpected admission action')
    })

    await expect(acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)).rejects.toThrow(
      'response lost after commit',
    )

    expect(countedDuringResponseLoss).toBe(true)
    expect(leases.size).toBe(0)
    expect(fetchAdmission).toHaveBeenCalledTimes(2)
  })

  it('rejects a different returned lease and cleans up the proposed lease', async () => {
    let proposedLeaseId = ''
    let releasedLeaseId = ''
    const fetchAdmission = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { leaseId: string }
      if (String(input).endsWith('/acquire')) {
        proposedLeaseId = body.leaseId
        return Response.json({ active: true, leaseId: PAGE_B })
      }
      releasedLeaseId = body.leaseId
      return new Response(null, { status: 204 })
    })

    await expect(acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)).rejects.toThrow(
      'Invalid live stream admission response',
    )
    expect(releasedLeaseId).toBe(proposedLeaseId)
  })

  it('aborts a never-settling acquire and cleans its deadline timer', async () => {
    const signals: AbortSignal[] = []
    const acquireFetch = neverSettlingFetch(signals)
    const fetchAdmission = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/release')) {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return acquireFetch(input, init)
    })
    const acquire = acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)
    const rejection = expect(acquire).rejects.toThrow()

    await vi.advanceTimersByTimeAsync(LIVE_ADMISSION_FETCH_TIMEOUT_MS)

    await rejection
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a never-settling renew so stream-level retries can advance', async () => {
    const signals: AbortSignal[] = []
    const fetchAdmission = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { leaseId: string }
        return Response.json({ active: true, leaseId: body.leaseId })
      })
      .mockImplementationOnce(neverSettlingFetch(signals))
    const admission = await acquireLiveAdmission(fetchAdmission, 'room', PAGE_A)
    const renew = admission!.renew()
    const rejection = expect(renew).rejects.toThrow()

    await vi.advanceTimersByTimeAsync(LIVE_ADMISSION_FETCH_TIMEOUT_MS)

    await rejection
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('live stream admission', () => {
  it('ignores attacker-selected request IDs and deterministically replaces the oldest stream', () => {
    const registry = createLiveStreamRegistry()
    const replacements = Array.from({ length: LIVE_STREAMS_PER_USER_SCOPE + 1 }, () => {
      return vi.fn()
    })
    const registrations = replacements.map((replace) => {
      return registry.register('user-a', 'room', crypto.randomUUID(), vi.fn(), replace)
    })

    expect(
      new Set(
        registrations.map(({ connectionId }) => {
          return connectionId
        }),
      ).size,
    ).toBe(LIVE_STREAMS_PER_USER_SCOPE + 1)
    expect(replacements[0]).toHaveBeenCalledOnce()
    expect(
      replacements.slice(1).every((replace) => {
        return replace.mock.calls.length === 0
      }),
    ).toBe(true)
  })

  it('bounds floods independently by authenticated user and scope', () => {
    const registry = createLiveStreamRegistry()
    const roomReplacements = Array.from({ length: 100 }, () => {
      return vi.fn()
    })
    for (const replace of roomReplacements) {
      registry.register('user-a', 'room', crypto.randomUUID(), vi.fn(), replace)
    }
    const lobbyReplace = vi.fn()
    const otherUserReplace = vi.fn()
    registry.register('user-a', 'lobby', crypto.randomUUID(), vi.fn(), lobbyReplace)
    registry.register('user-b', 'room', crypto.randomUUID(), vi.fn(), otherUserReplace)

    expect(
      roomReplacements.filter((replace) => {
        return replace.mock.calls.length > 0
      }),
    ).toHaveLength(100 - LIVE_STREAMS_PER_USER_SCOPE)
    expect(lobbyReplace).not.toHaveBeenCalled()
    expect(otherUserReplace).not.toHaveBeenCalled()
  })

  it('releases cleaned-up slots without replacing a live stream', () => {
    const registry = createLiveStreamRegistry(2)
    const firstReplace = vi.fn()
    const first = registry.register('user-a', 'lobby', PAGE_A, vi.fn(), firstReplace)
    registry.register('user-a', 'lobby', PAGE_B, vi.fn(), vi.fn())

    first.unregister()
    registry.register('user-a', 'lobby', crypto.randomUUID(), vi.fn(), vi.fn())

    expect(firstReplace).not.toHaveBeenCalled()
    first.unregister()
  })

  it('replaces only the stale generation for the reconnecting page', () => {
    const registry = createLiveStreamRegistry()
    const firstPageReplace = vi.fn()
    const otherPageReplace = vi.fn()
    registry.register('user-a', 'room', PAGE_A, vi.fn(), firstPageReplace)
    registry.register('user-a', 'room', PAGE_B, vi.fn(), otherPageReplace)

    registry.register('user-a', 'room', PAGE_A, vi.fn(), vi.fn())

    expect(firstPageReplace).toHaveBeenCalledOnce()
    expect(otherPageReplace).not.toHaveBeenCalled()
  })
})
