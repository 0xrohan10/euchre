import { Effect, type ManagedRuntime } from 'effect'
import { env, waitUntil } from 'cloudflare:workers'
import type { Database } from '../db/index.server'
import { createDb } from '../db/index.server'
import { createAuth } from '../lib/auth.server'
import type { PartyView, RoomView } from '../multiplayer'
import { createGameRuntime, GameService, GameServiceError } from './game-service.server'
import {
  createLiveSnapshotResponse,
  type LiveAdmissionRenewal,
  type LiveStreamError,
} from './live-stream.server'

export type LobbySnapshot = {
  party: PartyView | null
  room: RoomView | null
}

type LiveConnection<T> = {
  loadSnapshot: () => Promise<T>
  dispose: () => void | Promise<void>
}

export type LiveAdmissionLease = {
  renew: () => Promise<LiveAdmissionRenewal>
  releaseOnce: () => Promise<void>
  release: () => Promise<void>
}

export type LiveEventHandlerDependencies<Context> = {
  authenticate: (request: Request) => Promise<Context | null>
  userId: (context: Context) => string
  openLobby: (context: Context) => LiveConnection<LobbySnapshot>
  openRoom: (context: Context, roomId: string) => LiveConnection<RoomView>
  waitUntil?: (promise: Promise<void>) => void
  acquireAdmission?: (
    context: Context,
    scope: 'lobby' | 'room',
    pageId: string,
  ) => Promise<LiveAdmissionLease | null>
}

export type LiveStreamRegistry = {
  register: (
    userId: string,
    scope: 'lobby' | 'room',
    pageId: string,
    cleanup: () => void,
    replace: () => void,
  ) => { connectionId: string; unregister: () => void }
}

export const LIVE_STREAMS_PER_USER_SCOPE = 3
const LOBBY_REFRESH_INTERVAL_MS = 2_000
const LIVE_ADMISSION_RELEASE_ATTEMPTS = 4
const LIVE_ADMISSION_RELEASE_BASE_DELAY_MS = 100
export const LIVE_ADMISSION_FETCH_TIMEOUT_MS = 2_000

type AdmissionAction = 'acquire' | 'renew' | 'release'
type AdmissionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type AdmissionInvoke = (action: AdmissionAction, body: object) => Promise<Response>

function createAdmissionInvoke(fetchAdmission: AdmissionFetch): AdmissionInvoke {
  return async (action, body) => {
    const controller = new AbortController()
    const deadline = setTimeout(() => {
      controller.abort(new Error('Live stream admission request timed out'))
    }, LIVE_ADMISSION_FETCH_TIMEOUT_MS)
    try {
      return await fetchAdmission(`https://live-stream-admission/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(deadline)
    }
  }
}

export async function releaseLiveAdmission(
  invoke: AdmissionInvoke,
  leaseId: string,
  sleep: (delayMs: number) => Promise<void> = (delayMs) => {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    })
  },
): Promise<void> {
  for (let attempt = 1; attempt <= LIVE_ADMISSION_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await releaseLiveAdmissionOnce(invoke, leaseId)
      return
    } catch {
      // Release is idempotent, so transport failures are safe to retry.
    }
    if (attempt < LIVE_ADMISSION_RELEASE_ATTEMPTS) {
      await sleep(LIVE_ADMISSION_RELEASE_BASE_DELAY_MS * 2 ** (attempt - 1))
    }
  }
  throw new Error('Live stream admission release failed')
}

export async function releaseLiveAdmissionOnce(
  invoke: AdmissionInvoke,
  leaseId: string,
): Promise<void> {
  const response = await invoke('release', { leaseId })
  if (!response.ok) {
    throw new Error('Live stream admission release failed')
  }
}

export function createManagedLiveConnection<T, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  loadSnapshot: () => Effect.Effect<T, E, R>,
): LiveConnection<T> {
  return {
    loadSnapshot: () => {
      return runtime.runPromise(loadSnapshot())
    },
    dispose: () => {
      return runtime.dispose()
    },
  }
}

export function createLiveStreamRegistry(
  maximumPerUserScope = LIVE_STREAMS_PER_USER_SCOPE,
): LiveStreamRegistry {
  const streams = new Map<
    string,
    Map<string, { pageId: string; cleanup: () => void; replace: () => void }>
  >()
  return {
    register(userId, scope, pageId, cleanup, replace) {
      const key = `${userId}:${scope}`
      const scopedStreams = streams.get(key) ?? new Map()
      streams.set(key, scopedStreams)
      for (const [existingId, existing] of scopedStreams) {
        if (existing.pageId === pageId) {
          scopedStreams.delete(existingId)
          existing.replace()
          break
        }
      }
      const connectionId = crypto.randomUUID()
      scopedStreams.set(connectionId, { pageId, cleanup, replace })

      if (scopedStreams.size > maximumPerUserScope) {
        const oldest = scopedStreams.entries().next().value
        if (oldest) {
          const [oldestConnectionId, oldestStream] = oldest
          scopedStreams.delete(oldestConnectionId)
          oldestStream.replace()
        }
      }

      return {
        connectionId,
        unregister: () => {
          const currentStreams = streams.get(key)
          const current = currentStreams?.get(connectionId)
          if (current?.cleanup === cleanup) {
            currentStreams?.delete(connectionId)
            if (currentStreams?.size === 0) {
              streams.delete(key)
            }
          }
        },
      }
    },
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function liveStreamPageId(request: Request): string | undefined {
  const url = new URL(request.url)
  const pageId =
    url.searchParams.get('page') ??
    url.searchParams.get('connection') ??
    url.searchParams.get('stream') ??
    undefined
  return pageId && UUID_PATTERN.test(pageId) ? pageId : undefined
}

function isLegacyLiveStreamRequest(request: Request): boolean {
  const search = new URL(request.url).searchParams
  return search.has('stream') && !search.has('page') && !search.has('connection')
}

export async function parseLiveAdmissionRenewal(response: Response): Promise<LiveAdmissionRenewal> {
  if (response.status === 404) {
    return 'expired'
  }
  if (response.status === 409) {
    return 'replaced'
  }
  if (!response.ok) {
    throw new Error('Live stream admission renewal failed')
  }
  const result: unknown = await response.json()
  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'active'
  ) {
    return 'active'
  }
  throw new Error('Invalid live stream admission renewal response')
}

export async function acquireLiveAdmission(
  fetchAdmission: AdmissionFetch,
  scope: 'lobby' | 'room',
  pageId: string,
): Promise<LiveAdmissionLease | null> {
  const proposedLeaseId = crypto.randomUUID()
  const invoke = createAdmissionInvoke(fetchAdmission)
  let acquired: Response
  try {
    acquired = await invoke('acquire', { scope, pageId, leaseId: proposedLeaseId })
  } catch (error) {
    await releaseLiveAdmission(invoke, proposedLeaseId).catch(() => {})
    throw error
  }
  if (acquired.status === 429) {
    return null
  }
  if (!acquired.ok) {
    await releaseLiveAdmission(invoke, proposedLeaseId).catch(() => {})
    throw new Error('Live stream admission failed')
  }
  let result: unknown
  try {
    result = await acquired.json()
  } catch {
    await releaseLiveAdmission(invoke, proposedLeaseId).catch(() => {})
    throw new Error('Invalid live stream admission response')
  }
  if (
    typeof result !== 'object' ||
    result === null ||
    !('leaseId' in result) ||
    typeof result.leaseId !== 'string' ||
    result.leaseId !== proposedLeaseId
  ) {
    await releaseLiveAdmission(invoke, proposedLeaseId).catch(() => {})
    throw new Error('Invalid live stream admission response')
  }
  const leaseId = result.leaseId
  return {
    async renew() {
      const response = await invoke('renew', { leaseId })
      return parseLiveAdmissionRenewal(response)
    },
    async releaseOnce() {
      await releaseLiveAdmissionOnce(invoke, leaseId)
    },
    async release() {
      await releaseLiveAdmission(invoke, leaseId)
    },
  }
}

function classifyGameError(error: unknown): LiveStreamError | undefined {
  if (
    error instanceof GameServiceError &&
    (error.code === 'not-found' || error.code === 'forbidden')
  ) {
    return { code: error.code }
  }
  return undefined
}

export function createLiveEventHandlers<Context>(
  dependencies: LiveEventHandlerDependencies<Context>,
  registry: LiveStreamRegistry = createLiveStreamRegistry(),
) {
  const authenticate = async (request: Request) => {
    const context = await dependencies.authenticate(request)
    return context ?? new Response('Unauthorized', { status: 401 })
  }

  return {
    async lobby(request: Request): Promise<Response> {
      const authentication = await authenticate(request)
      if (authentication instanceof Response) {
        return authentication
      }
      const userId = dependencies.userId(authentication)
      const pageId = liveStreamPageId(request)
      if (!pageId) {
        return new Response('Invalid page identity', { status: 400 })
      }
      let admission: LiveAdmissionLease | null | undefined
      try {
        admission = await dependencies.acquireAdmission?.(authentication, 'lobby', pageId)
      } catch {
        return new Response('Stream admission unavailable', { status: 503 })
      }
      if (dependencies.acquireAdmission && !admission) {
        return new Response('Too many live streams', { status: 429 })
      }
      const connection = dependencies.openLobby(authentication)
      return createLiveSnapshotResponse({
        request: { signal: request.signal },
        scope: 'lobby',
        loadSnapshot: connection.loadSnapshot,
        terminalAfterSnapshot: (snapshot) => {
          return snapshot.room ? 'room-assigned' : undefined
        },
        classifyError: classifyGameError,
        renewAdmission: admission?.renew,
        legacyMaxLifetime: isLegacyLiveStreamRequest(request),
        pollIntervalMs: LOBBY_REFRESH_INTERVAL_MS,
        waitUntil: dependencies.waitUntil ?? waitUntil,
        onCleanup: connection.dispose,
        releaseAdmissionOnce: admission?.releaseOnce,
        releaseAdmission: admission?.release,
        registerCleanup: (cleanup, replace) => {
          return registry.register(userId, 'lobby', pageId, cleanup, replace).unregister
        },
      })
    },

    async room(request: Request, roomId: string): Promise<Response> {
      const authentication = await authenticate(request)
      if (authentication instanceof Response) {
        return authentication
      }
      const userId = dependencies.userId(authentication)
      const pageId = liveStreamPageId(request)
      if (!pageId) {
        return new Response('Invalid page identity', { status: 400 })
      }
      let admission: LiveAdmissionLease | null | undefined
      try {
        admission = await dependencies.acquireAdmission?.(authentication, 'room', pageId)
      } catch {
        return new Response('Stream admission unavailable', { status: 503 })
      }
      if (dependencies.acquireAdmission && !admission) {
        return new Response('Too many live streams', { status: 429 })
      }
      const connection = dependencies.openRoom(authentication, roomId)
      return createLiveSnapshotResponse({
        request: { signal: request.signal },
        scope: 'room',
        loadSnapshot: connection.loadSnapshot,
        classifyError: classifyGameError,
        renewAdmission: admission?.renew,
        legacyMaxLifetime: isLegacyLiveStreamRequest(request),
        waitUntil: dependencies.waitUntil ?? waitUntil,
        onCleanup: connection.dispose,
        releaseAdmissionOnce: admission?.releaseOnce,
        releaseAdmission: admission?.release,
        registerCleanup: (cleanup, replace) => {
          return registry.register(userId, 'room', pageId, cleanup, replace).unregister
        },
      })
    },
  }
}

type AuthenticatedContext = {
  userId: string
  database: Database
}

// Keep local replacement responsive; the admission Durable Object enforces the global cap.
const registry = createLiveStreamRegistry()

export const liveEventHandlers = createLiveEventHandlers<AuthenticatedContext>(
  {
    async authenticate(request) {
      const database = createDb()
      const auth = createAuth(database)
      const session = await auth.api.getSession({ headers: request.headers })
      return session ? { userId: session.user.id, database } : null
    },
    userId(context) {
      return context.userId
    },
    async acquireAdmission(context, scope, pageId) {
      const gate = env.LIVE_STREAM_ADMISSION.getByName(context.userId)
      return acquireLiveAdmission(
        (input, init) => {
          return gate.fetch(input, init)
        },
        scope,
        pageId,
      )
    },
    openLobby(context) {
      const runtime = createGameRuntime(context.database)
      return createManagedLiveConnection(runtime, () => {
        return Effect.flatMap(GameService, (games) => {
          return games.waitingLobby(context.userId)
        })
      })
    },
    openRoom(context, roomId) {
      const runtime = createGameRuntime(context.database)
      return createManagedLiveConnection(runtime, () => {
        return Effect.flatMap(GameService, (games) => {
          return games.tick(context.userId, roomId)
        })
      })
    },
  },
  registry,
)
