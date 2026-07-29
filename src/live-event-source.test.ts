import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPageConnectionIdentity,
  startLiveEventSource,
  type EventSourceLike,
} from './live-event-source'

class FakeEventSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(event: Event) => void>>()
  readonly close = vi.fn()

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, data?: unknown) {
    const event =
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify({ version: 1, ...data }) })
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  emitLegacy(type: 'room' | 'gone', data?: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data ?? {}) })
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('startLiveEventSource', () => {
  let sources: FakeEventSource[]
  let online: boolean
  let visibility: DocumentVisibilityState
  let onlineListeners: Array<() => void>
  let offlineListeners: Array<() => void>
  let visibilityListeners: Array<() => void>
  let sourceUrls: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    sources = []
    online = true
    visibility = 'visible'
    onlineListeners = []
    offlineListeners = []
    visibilityListeners = []
    sourceUrls = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function start(
    onSnapshot = vi.fn(),
    options: {
      scope?: 'lobby' | 'room'
      onFallback?: () => void
      onTerminal?: (terminal: { code: string }) => void
      onConnectionChange?: (state: {
        status: 'live' | 'reconnecting' | 'stale'
        snapshotTrusted: boolean
      }) => void
    } = {},
  ) {
    const add = (listeners: Array<() => void>, listener: () => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) {
          listeners.splice(index, 1)
        }
      }
    }
    const manager = startLiveEventSource<{ value: number }>({
      url: '/events',
      scope: options.scope ?? 'lobby',
      onSnapshot,
      onFallback: options.onFallback,
      onTerminal: options.onTerminal,
      onConnectionChange: options.onConnectionChange,
      environment: {
        createEventSource: (url) => {
          sourceUrls.push(url)
          const source = new FakeEventSource()
          sources.push(source)
          return source
        },
        isOnline: () => {
          return online
        },
        visibilityState: () => {
          return visibility
        },
        addOnlineListener: (listener) => {
          return add(onlineListeners, listener)
        },
        addOfflineListener: (listener) => {
          return add(offlineListeners, listener)
        },
        addVisibilityListener: (listener) => {
          return add(visibilityListeners, listener)
        },
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
        random: () => {
          return 0.5
        },
      },
    })
    return { manager, onSnapshot, sourceUrls }
  }

  it('applies current versioned snapshots and rejects stale generations', async () => {
    const { manager, onSnapshot } = start()
    const first = sources[0]
    first.emit('ready', { scope: 'lobby', heartbeatMs: 15_000, maxLifetimeMs: 300_000 })
    first.emit('snapshot', { scope: 'lobby', snapshot: { value: 1 } })
    expect(onSnapshot).toHaveBeenCalledWith({ value: 1 })

    first.emit('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(sources).toHaveLength(2)
    first.emit('snapshot', { scope: 'lobby', snapshot: { value: 2 } })
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    manager.stop()
  })

  it('keeps healthy hidden streams open and bounds hidden retries to 30 seconds', async () => {
    const { manager } = start()
    const first = sources[0]
    visibility = 'hidden'
    for (const listener of visibilityListeners) {
      listener()
    }
    expect(first.close).not.toHaveBeenCalled()

    first.emit('error')
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(2)

    manager.stop()
  })

  it('reconnects a hidden room after an ordinary error before presence can become stale', async () => {
    const { manager } = start(vi.fn(), { scope: 'room' })
    sources[0].emit('snapshot', { scope: 'room', snapshot: { value: 1 } })
    visibility = 'hidden'

    sources[0].emit('error')
    await vi.advanceTimersByTimeAsync(499)
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(2)

    manager.stop()
  })

  it('closes offline and reconnects immediately online', () => {
    const { manager } = start()
    online = false
    for (const listener of offlineListeners) {
      listener()
    }
    expect(sources[0].close).toHaveBeenCalledOnce()

    online = true
    for (const listener of onlineListeners) {
      listener()
    }
    expect(sources).toHaveLength(2)

    manager.stop()
  })

  it('reports live, trusted reconnecting, and stale room snapshots', async () => {
    const onConnectionChange = vi.fn()
    const { manager } = start(vi.fn(), { scope: 'room', onConnectionChange })
    expect(onConnectionChange).toHaveBeenLastCalledWith({
      status: 'reconnecting',
      snapshotTrusted: false,
    })

    sources[0].emit('snapshot', { scope: 'room', snapshot: { value: 1 } })
    expect(onConnectionChange).toHaveBeenLastCalledWith({
      status: 'live',
      snapshotTrusted: true,
    })

    sources[0].emit('error')
    expect(onConnectionChange).toHaveBeenLastCalledWith({
      status: 'reconnecting',
      snapshotTrusted: true,
    })

    await vi.advanceTimersByTimeAsync(12_000)
    expect(onConnectionChange).toHaveBeenLastCalledWith({
      status: 'stale',
      snapshotTrusted: false,
    })
    manager.stop()
  })

  it('reconnects when the heartbeat watchdog expires', async () => {
    const { manager } = start()
    sources[0].emit('ready', {
      scope: 'lobby',
      heartbeatMs: 1_000,
      maxLifetimeMs: 300_000,
    })
    await vi.advanceTimersByTimeAsync(3_001)
    await vi.advanceTimersByTimeAsync(500)
    expect(sources).toHaveLength(2)

    manager.stop()
  })

  it('does not let room heartbeats mask missing snapshot progress', async () => {
    const { manager } = start(vi.fn(), { scope: 'room' })
    sources[0].emit('ready', {
      scope: 'room',
      heartbeatMs: 1_000,
      maxLifetimeMs: 300_000,
    })
    for (let elapsed = 1_000; elapsed <= 12_000; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000)
      sources[0].emit('heartbeat', { at: elapsed })
    }
    await vi.advanceTimersByTimeAsync(500)

    expect(sources).toHaveLength(2)
    manager.stop()
  })

  it.each(['snapshot', 'room'] as const)(
    'treats unchanged %s snapshots as authoritative room progress without React updates',
    async (eventType) => {
      const { manager, onSnapshot } = start(vi.fn(), { scope: 'room' })
      const first = sources[0]
      const emitSnapshot = () => {
        if (eventType === 'snapshot') {
          first.emit('snapshot', { scope: 'room', snapshot: { value: 1 } })
        } else {
          first.emitLegacy('room', { value: 1 })
        }
      }

      emitSnapshot()
      await vi.advanceTimersByTimeAsync(11_000)
      emitSnapshot()
      await vi.advanceTimersByTimeAsync(11_000)

      expect(sources).toHaveLength(1)
      expect(onSnapshot).toHaveBeenCalledOnce()
      manager.stop()
    },
  )

  it('keeps increasing retry backoff across repeated ready-error connections', async () => {
    const { manager } = start()
    sources[0].emit('ready', {
      scope: 'lobby',
      heartbeatMs: 15_000,
      maxLifetimeMs: 300_000,
    })
    sources[0].emit('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(sources).toHaveLength(2)

    sources[1].emit('ready', {
      scope: 'lobby',
      heartbeatMs: 15_000,
      maxLifetimeMs: 300_000,
    })
    sources[1].emit('error')
    await vi.advanceTimersByTimeAsync(999)
    expect(sources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(3)

    sources[2].emit('snapshot', { scope: 'lobby', snapshot: { value: 1 } })
    sources[2].emit('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(sources).toHaveLength(4)
    manager.stop()
  })

  it('falls back after an EventSource fails before its first snapshot', () => {
    const onFallback = vi.fn()
    const { manager } = start(vi.fn(), { onFallback })

    sources[0].emit('error')

    expect(onFallback).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('falls back after three failed generations following a successful generation', async () => {
    const onFallback = vi.fn()
    const { manager } = start(vi.fn(), { onFallback })
    sources[0].emit('snapshot', { scope: 'lobby', snapshot: { value: 1 } })

    sources[0].emit('error')
    await vi.advanceTimersByTimeAsync(500)
    sources[1].emit('error')
    await vi.advanceTimersByTimeAsync(1_000)
    sources[2].emit('error')
    await vi.advanceTimersByTimeAsync(2_000)
    sources[3].emit('error')

    expect(onFallback).toHaveBeenCalledOnce()
    manager.stop()
  })

  it('accepts legacy room events without applying a dual-emitted snapshot twice', () => {
    const { manager, onSnapshot } = start(vi.fn(), { scope: 'room' })
    sources[0].emit('snapshot', { scope: 'room', snapshot: { value: 1 } })
    sources[0].emitLegacy('room', { value: 1 })
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    sources[0].emitLegacy('room', { value: 2 })
    expect(onSnapshot).toHaveBeenLastCalledWith({ value: 2 })
    manager.stop()
  })

  it('maps a legacy gone event to a terminal room result', () => {
    const onTerminal = vi.fn()
    const { manager } = start(vi.fn(), { scope: 'room', onTerminal })

    sources[0].emitLegacy('gone')

    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'not-found', reconnect: false }),
    )
    manager.stop()
  })

  it('keeps one in-memory connection identity for the page', () => {
    expect(getPageConnectionIdentity()).toBe(getPageConnectionIdentity())
  })

  it('stops permanently on non-reconnectable terminal events', async () => {
    const { manager } = start()
    sources[0].emit('terminal', { code: 'forbidden', reconnect: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sources).toHaveLength(1)

    manager.stop()
    manager.stop()
    expect(onlineListeners).toHaveLength(0)
  })

  it('does not reconnect an isolate-cap replacement', async () => {
    const { manager } = start()
    sources[0].emit('terminal', { code: 'replaced', reconnect: false })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sources).toHaveLength(1)
    manager.stop()
  })

  it('reconnects after admission expiry so a new lease can be acquired', async () => {
    const { manager } = start()
    sources[0].emit('terminal', { code: 'expired', reconnect: true })

    await vi.advanceTimersByTimeAsync(500)

    expect(sources).toHaveLength(2)
    manager.stop()
  })

  it('keeps every hidden room reconnect below the stale-presence threshold', async () => {
    const { manager, onSnapshot } = start(vi.fn(), { scope: 'room' })
    const first = sources[0]
    first.emit('snapshot', { scope: 'room', snapshot: { value: 1 } })
    visibility = 'hidden'

    first.emit('terminal', { code: 'refresh', reconnect: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(sources).toHaveLength(2)

    sources[1].emit('error')
    await vi.advanceTimersByTimeAsync(499)
    expect(sources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(3)

    sources[2].emit('snapshot', { scope: 'room', snapshot: { value: 2 } })
    expect(onSnapshot).toHaveBeenLastCalledWith({ value: 2 })

    sources[2].emit('error')
    await vi.advanceTimersByTimeAsync(499)
    expect(sources).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(4)

    manager.stop()
  })
})
