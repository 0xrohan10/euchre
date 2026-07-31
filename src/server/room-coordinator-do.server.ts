import { DurableObject } from 'cloudflare:workers'
import { LIVE_EVENT_PROTOCOL_VERSION, frameLegacyLiveEvent, frameLiveEvent } from '../live-events'
import { LIVE_HEARTBEAT_MS, LIVE_MAX_LIFETIME_MS } from './live-stream.server'
import { HEARTBEAT_WRITE_MS } from './tick-policy'
import { roomCoordinatorMode, shouldUseRoomCoordinator } from './room-coordinator-policy'
import { DirtyLoop } from './dirty-loop.server'

type Connection = {
  userId: string
  pageId: string
  leaseId: string
  controller: ReadableStreamDefaultController<Uint8Array>
  openedAt: number
  nextHeartbeatAt: number
  lastPayload?: string
  legacy: boolean
}

const encoder = new TextEncoder()
const ROOM_ID_KEY = 'roomId'
const OWNER_ID_KEY = 'ownerId'

class RoomCoordinatorOwnershipContention extends Error {}

export class RoomCoordinator extends DurableObject<Env> {
  private readonly connections = new Map<string, Connection>()
  private timer?: ReturnType<typeof setTimeout>
  private roomId?: string
  private nextPresenceAt = 0
  private readonly reconciliation = new DirtyLoop(
    () => {
      return this.run()
    },
    async () => {
      await this.ctx.storage.setAlarm(Date.now() + 1_000)
    },
  )
  private ownerId?: string
  private ownerEpoch?: number

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname
    if (action === '/poke') {
      this.ctx.waitUntil(this.reconcile())
      return new Response(null, { status: 204 })
    }
    if (action === '/wakeup') {
      const wakeup: unknown = await request.json().catch(() => {
        return undefined
      })
      if (
        typeof wakeup !== 'object' ||
        wakeup === null ||
        !('roomId' in wakeup) ||
        !('deadlineAt' in wakeup) ||
        typeof wakeup.roomId !== 'string' ||
        typeof wakeup.deadlineAt !== 'number'
      ) {
        return new Response('Invalid wakeup', { status: 400 })
      }
      if (this.roomId && this.roomId !== wakeup.roomId) {
        return new Response('Room mismatch', { status: 409 })
      }
      this.roomId = wakeup.roomId
      await this.ctx.storage.put(ROOM_ID_KEY, wakeup.roomId)
      await this.ctx.storage.setAlarm(Math.max(Date.now(), wakeup.deadlineAt))
      this.ctx.waitUntil(this.reconcile())
      return new Response(null, { status: 204 })
    }
    if (action !== '/connect') {
      return new Response('Not found', { status: 404 })
    }
    const capability: unknown = await request.json().catch(() => {
      return undefined
    })
    if (
      typeof capability !== 'object' ||
      capability === null ||
      !('roomId' in capability) ||
      !('userId' in capability) ||
      !('pageId' in capability) ||
      !('leaseId' in capability) ||
      typeof capability.roomId !== 'string' ||
      typeof capability.userId !== 'string' ||
      typeof capability.pageId !== 'string' ||
      typeof capability.leaseId !== 'string'
    ) {
      return new Response('Invalid connection', { status: 400 })
    }
    const { roomId, userId, pageId, leaseId } = capability
    const transfer = await this.env.LIVE_STREAM_ADMISSION.getByName(userId).fetch(
      'https://live-stream-admission/transfer',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, scope: 'room', pageId, leaseId }),
      },
    )
    if (!transfer.ok) {
      return new Response('Invalid admission capability', { status: 403 })
    }
    if (this.roomId && this.roomId !== roomId) {
      return new Response('Room mismatch', { status: 409 })
    }
    this.roomId = roomId
    await this.ctx.storage.put(ROOM_ID_KEY, roomId)

    let cancel = () => {}
    let connectionId: string | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const [id, connection] of this.connections) {
          if (connection.userId === userId && connection.pageId === pageId) {
            this.close(id, 'replaced')
          }
        }
        const id = crypto.randomUUID()
        connectionId = id
        const now = Date.now()
        this.connections.set(id, {
          userId,
          pageId,
          leaseId,
          controller,
          openedAt: now,
          nextHeartbeatAt: now + LIVE_HEARTBEAT_MS,
          legacy: 'legacy' in capability && capability.legacy === true,
        })
        cancel = () => {
          return this.close(id)
        }
        this.send(
          id,
          frameLiveEvent('ready', {
            version: LIVE_EVENT_PROTOCOL_VERSION,
            scope: 'room',
            heartbeatMs: LIVE_HEARTBEAT_MS,
            maxLifetimeMs: LIVE_MAX_LIFETIME_MS,
          }),
        )
        request.signal.addEventListener('abort', cancel, { once: true })
      },
      cancel: () => {
        return cancel()
      },
    })
    try {
      await this.reconcile()
    } catch (error) {
      if (error instanceof RoomCoordinatorOwnershipContention) {
        cancel()
        return new Response('Room coordinator handover in progress', {
          status: 503,
          headers: { 'x-room-coordinator-retry': 'ownership', 'Retry-After': '1' },
        })
      }
      const admission = connectionId ? await this.returnConnection(connectionId) : 'released'
      return new Response('Room coordinator unavailable', {
        status: 503,
        headers: { 'x-room-coordinator-admission': admission },
      })
    }
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  }

  async alarm(): Promise<void> {
    this.roomId ??= await this.ctx.storage.get<string>(ROOM_ID_KEY)
    await this.reconcile()
  }

  private close(connectionId: string, terminal?: 'replaced' | 'refresh' | 'expired') {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return
    }
    if (terminal) {
      this.send(
        connectionId,
        frameLiveEvent('terminal', {
          version: LIVE_EVENT_PROTOCOL_VERSION,
          code: terminal,
          reconnect: terminal !== 'replaced',
        }),
      )
    }
    this.connections.delete(connectionId)
    try {
      connection.controller.close()
    } catch {}
    this.ctx.waitUntil(this.release(connection.userId, connection.pageId, connection.leaseId))
    this.scheduleTimer()
  }

  private async release(userId: string, pageId: string, leaseId: string) {
    try {
      await this.env.LIVE_STREAM_ADMISSION.getByName(userId).fetch(
        'https://live-stream-admission/release',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, scope: 'room', pageId, leaseId }),
        },
      )
    } catch {}
  }

  private async returnConnection(connectionId: string): Promise<'returned' | 'released'> {
    const connection = this.connections.get(connectionId)
    if (!connection) {
      return 'released'
    }
    this.connections.delete(connectionId)
    try {
      connection.controller.close()
    } catch {}
    const response = await this.env.LIVE_STREAM_ADMISSION.getByName(connection.userId).fetch(
      'https://live-stream-admission/return',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: connection.userId,
          scope: 'room',
          pageId: connection.pageId,
          leaseId: connection.leaseId,
        }),
      },
    )
    if (!response.ok) {
      await this.release(connection.userId, connection.pageId, connection.leaseId)
      this.scheduleTimer()
      return 'released'
    }
    this.scheduleTimer()
    return 'returned'
  }

  private send(connectionId: string, frame: string) {
    try {
      this.connections.get(connectionId)?.controller.enqueue(encoder.encode(frame))
    } catch {
      this.close(connectionId)
    }
  }

  private reconcile(): Promise<void> {
    return this.reconciliation.signal()
  }

  private async maintainConnections(now: number) {
    for (const [id, connection] of [...this.connections]) {
      if (now - connection.openedAt >= LIVE_MAX_LIFETIME_MS) {
        this.close(id, connection.legacy ? undefined : 'refresh')
        continue
      }
      if (now < connection.nextHeartbeatAt) {
        continue
      }
      let response: Response
      try {
        response = await this.env.LIVE_STREAM_ADMISSION.getByName(connection.userId).fetch(
          'https://live-stream-admission/renew',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              userId: connection.userId,
              scope: 'room',
              pageId: connection.pageId,
              leaseId: connection.leaseId,
            }),
          },
        )
      } catch {
        connection.nextHeartbeatAt = now + 1_000
        continue
      }
      if (!response.ok) {
        this.close(id, response.status === 409 ? 'replaced' : 'expired')
        continue
      }
      this.send(id, frameLiveEvent('heartbeat', { version: LIVE_EVENT_PROTOCOL_VERSION, at: now }))
      connection.nextHeartbeatAt = now + LIVE_HEARTBEAT_MS
    }
  }

  private async run() {
    this.roomId ??= await this.ctx.storage.get<string>(ROOM_ID_KEY)
    if (!this.roomId) {
      return
    }
    const mode = roomCoordinatorMode(this.env.ROOM_COORDINATOR_MODE)
    const percentage = Number(this.env.ROOM_COORDINATOR_PERCENTAGE ?? '0')
    if (!shouldUseRoomCoordinator(this.roomId, mode, percentage)) {
      for (const id of [...this.connections.keys()]) {
        this.close(id, 'refresh')
      }
      await this.ctx.storage.deleteAlarm()
      return
    }
    this.ownerId ??= await this.ctx.storage.get<string>(OWNER_ID_KEY)
    if (!this.ownerId) {
      this.ownerId = crypto.randomUUID()
      await this.ctx.storage.put(OWNER_ID_KEY, this.ownerId)
    }
    const [{ createDb }, { projectRoomViews, reconcileCoordinatedRoom }] = await Promise.all([
      import('../db/index.server'),
      import('./room-reconciliation.server'),
    ])
    const database = createDb()
    const now = Date.now()
    await this.maintainConnections(now)
    const users = [
      ...new Set(
        [...this.connections.values()].map(({ userId }) => {
          return userId
        }),
      ),
    ]
    const renewPresence = users.length > 0 && now >= this.nextPresenceAt
    const result = await reconcileCoordinatedRoom(
      database,
      this.roomId,
      users,
      renewPresence,
      new Date(now),
      { ownerId: this.ownerId, epoch: this.ownerEpoch },
    )
    if (!result.ownership) {
      for (const id of [...this.connections.keys()]) {
        this.close(id, 'refresh')
      }
      await this.ctx.storage.deleteAlarm()
      throw new RoomCoordinatorOwnershipContention()
    }
    this.ownerEpoch = result.ownership.epoch
    if (renewPresence) {
      this.nextPresenceAt = now + HEARTBEAT_WRITE_MS
    }
    if (!result.snapshot) {
      for (const id of [...this.connections.keys()]) {
        this.close(id)
      }
      await this.ctx.storage.deleteAlarm()
      return
    }

    const views = projectRoomViews(result.snapshot, users)
    for (const [id, connection] of this.connections) {
      const view = views.get(connection.userId)
      if (!view) {
        this.close(id)
        continue
      }
      const payload = JSON.stringify(view)
      if (payload !== connection.lastPayload) {
        this.send(
          id,
          frameLiveEvent('snapshot', {
            version: LIVE_EVENT_PROTOCOL_VERSION,
            scope: 'room',
            snapshot: view,
          }),
        )
        this.send(id, frameLegacyLiveEvent('room', view))
        connection.lastPayload = payload
      }
    }

    if (result.alarm) {
      await this.ctx.storage.setAlarm(Math.max(now, result.alarm.at))
    } else {
      await this.ctx.storage.deleteAlarm()
    }
    this.scheduleTimer()
  }

  private scheduleTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    if (this.connections.size === 0) {
      return
    }
    const now = Date.now()
    const connectionDeadline = Math.min(
      ...[...this.connections.values()].flatMap((connection) => {
        return [connection.nextHeartbeatAt, connection.openedAt + LIVE_MAX_LIFETIME_MS]
      }),
    )
    const deadline = Math.min(this.nextPresenceAt || now, connectionDeadline)
    this.timer = setTimeout(
      () => {
        return void this.reconcile()
      },
      Math.max(0, deadline - now),
    )
  }
}
