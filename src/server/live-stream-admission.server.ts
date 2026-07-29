import type { LiveEventScope } from '../live-events'

export const LIVE_ADMISSION_MAX_LEASES = 3
export const LIVE_ADMISSION_TTL_MS = 45_000

type Lease = {
  scope: LiveEventScope
  pageId: string
  leaseId: string
  expiresAt: number
  status: 'active' | 'replaced'
}

export type AdmissionStorage = {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  setAlarm(time: number): Promise<void>
  deleteAlarm(): Promise<void>
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORAGE_KEY = 'leases'

export class LiveStreamAdmissionState {
  readonly leases: Lease[]

  constructor(leases: readonly Lease[] = []) {
    this.leases = [...leases]
  }

  prune(now: number) {
    for (let index = this.leases.length - 1; index >= 0; index -= 1) {
      if (this.leases[index].expiresAt <= now) {
        this.leases.splice(index, 1)
      }
    }
  }

  acquire(
    scope: LiveEventScope,
    pageId: string,
    leaseId: string,
    now: number,
  ): { active: boolean; replaced: string[] } {
    this.prune(now)
    const scoped = this.leases.filter((lease) => {
      return lease.scope === scope
    })
    if (scoped.length >= LIVE_ADMISSION_MAX_LEASES) {
      return { active: false, replaced: [] }
    }

    const replaced: string[] = []
    for (const lease of scoped) {
      if (lease.pageId === pageId && lease.status === 'active') {
        lease.status = 'replaced'
        replaced.push(lease.leaseId)
      }
    }
    this.leases.push({
      scope,
      pageId,
      leaseId,
      expiresAt: now + LIVE_ADMISSION_TTL_MS,
      status: 'active',
    })
    return { active: true, replaced }
  }

  renew(leaseId: string, now: number): 'active' | 'expired' | 'replaced' {
    this.prune(now)
    const lease = this.leases.find((candidate) => {
      return candidate.leaseId === leaseId
    })
    if (!lease) {
      return 'expired'
    }
    if (lease.status === 'replaced') {
      return 'replaced'
    }
    lease.expiresAt = now + LIVE_ADMISSION_TTL_MS
    return 'active'
  }

  release(leaseId: string, now: number): boolean {
    this.prune(now)
    const index = this.leases.findIndex((lease) => {
      return lease.leaseId === leaseId
    })
    if (index < 0) {
      return false
    }
    this.leases.splice(index, 1)
    return true
  }
}

function isScope(value: unknown): value is LiveEventScope {
  return value === 'lobby' || value === 'room'
}

async function persist(storage: AdmissionStorage, state: LiveStreamAdmissionState) {
  await storage.put(STORAGE_KEY, state.leases)
  if (state.leases.length === 0) {
    await storage.deleteAlarm()
    return
  }
  await storage.setAlarm(
    Math.min(
      ...state.leases.map((lease) => {
        return lease.expiresAt
      }),
    ),
  )
}

export async function handleLiveStreamAdmissionRequest(
  storage: AdmissionStorage,
  request: Request,
  now = Date.now(),
): Promise<Response> {
  const body: unknown = await request.json().catch(() => {
    return undefined
  })
  if (typeof body !== 'object' || body === null || !('leaseId' in body)) {
    return new Response('Invalid admission request', { status: 400 })
  }
  const leaseId = body.leaseId
  if (typeof leaseId !== 'string' || !UUID_PATTERN.test(leaseId)) {
    return new Response('Invalid admission request', { status: 400 })
  }

  const state = new LiveStreamAdmissionState((await storage.get<Lease[]>(STORAGE_KEY)) ?? [])
  const action = new URL(request.url).pathname
  if (action === '/acquire') {
    if (!('scope' in body) || !('pageId' in body) || !isScope(body.scope)) {
      return new Response('Invalid admission request', { status: 400 })
    }
    if (typeof body.pageId !== 'string' || !UUID_PATTERN.test(body.pageId)) {
      return new Response('Invalid admission request', { status: 400 })
    }
    const result = state.acquire(body.scope, body.pageId, leaseId, now)
    await persist(storage, state)
    return Response.json(result.active ? { ...result, leaseId } : result, {
      status: result.active ? 200 : 429,
    })
  }
  if (action === '/renew') {
    const status = state.renew(leaseId, now)
    await persist(storage, state)
    return Response.json(
      { status },
      { status: status === 'active' ? 200 : status === 'replaced' ? 409 : 404 },
    )
  }
  if (action === '/release') {
    state.release(leaseId, now)
    await persist(storage, state)
    return new Response(null, { status: 204 })
  }
  return new Response('Not found', { status: 404 })
}

export async function expireLiveStreamAdmissionLeases(
  storage: AdmissionStorage,
  now = Date.now(),
): Promise<void> {
  const state = new LiveStreamAdmissionState((await storage.get<Lease[]>(STORAGE_KEY)) ?? [])
  state.prune(now)
  await persist(storage, state)
}
