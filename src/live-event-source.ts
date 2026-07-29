import {
  isProtocolMessage,
  type LiveEventScope,
  type LiveReady,
  type LiveSnapshot,
  type LiveTerminal,
} from './live-events'
import type { LiveConnectionState } from './interaction-feedback'

const MAX_RETRY_MS = 30_000
const HIDDEN_ROOM_MAX_RETRY_MS = 5_000
const DEFAULT_TRANSPORT_WATCHDOG_MS = 35_000
const ROOM_SNAPSHOT_WATCHDOG_MS = 12_000
const POST_SUCCESS_FAILURES_BEFORE_FALLBACK = 3
let pageConnectionIdentity: string | undefined

export function getPageConnectionIdentity(): string {
  pageConnectionIdentity ??= crypto.randomUUID()
  return pageConnectionIdentity
}

type Timer = ReturnType<typeof globalThis.setTimeout>

export type EventSourceLike = {
  addEventListener: (type: string, listener: (event: Event) => void) => void
  close: () => void
}

export type LiveEventSourceEnvironment = {
  createEventSource: (url: string) => EventSourceLike
  isOnline: () => boolean
  visibilityState: () => DocumentVisibilityState
  addOnlineListener: (listener: () => void) => () => void
  addOfflineListener: (listener: () => void) => () => void
  addVisibilityListener: (listener: () => void) => () => void
  setTimeout: (callback: () => void, delayMs: number) => Timer
  clearTimeout: (timer: Timer) => void
  random: () => number
}

export type LiveEventSourceOptions<T> = {
  url: string
  scope: LiveEventScope
  onSnapshot: (snapshot: T) => void
  onTerminal?: (terminal: LiveTerminal) => void
  onFallback?: () => void
  onConnectionChange?: (state: LiveConnectionState) => void
  environment?: LiveEventSourceEnvironment
}

export type LiveEventSourceManager = {
  stop: () => void
}

const browserEnvironment: LiveEventSourceEnvironment = {
  createEventSource: (url) => {
    return new EventSource(url)
  },
  isOnline: () => {
    return navigator.onLine
  },
  visibilityState: () => {
    return document.visibilityState
  },
  addOnlineListener: (listener) => {
    window.addEventListener('online', listener)
    return () => {
      window.removeEventListener('online', listener)
    }
  },
  addOfflineListener: (listener) => {
    window.addEventListener('offline', listener)
    return () => {
      window.removeEventListener('offline', listener)
    }
  },
  addVisibilityListener: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => {
      document.removeEventListener('visibilitychange', listener)
    }
  },
  setTimeout: (callback, delayMs) => {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout: (timer) => {
    globalThis.clearTimeout(timer)
  },
  random: () => {
    return Math.random()
  },
}

function parseMessage<T>(event: Event): T | undefined {
  if (!(event instanceof MessageEvent)) {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(String(event.data))
    return isProtocolMessage(value) ? (value as T) : undefined
  } catch {
    return undefined
  }
}

function parseLegacyMessage<T>(event: Event): T | undefined {
  if (!(event instanceof MessageEvent)) {
    return undefined
  }
  try {
    return JSON.parse(String(event.data)) as T
  } catch {
    return undefined
  }
}

export function startLiveEventSource<T>(
  options: LiveEventSourceOptions<T>,
): LiveEventSourceManager {
  const environment = options.environment ?? browserEnvironment
  let active = true
  let blockedByTerminal = false
  let fallbackStarted = false
  let hasSuccessfulGeneration = false
  let postSuccessFailureCount = 0
  let generation = 0
  let failureCount = 0
  let source: EventSourceLike | undefined
  let currentGenerationReceivedSnapshot = false
  let retryTimer: Timer | undefined
  let transportWatchdogTimer: Timer | undefined
  let snapshotWatchdogTimer: Timer | undefined
  let staleTimer: Timer | undefined
  let transportWatchdogMs = DEFAULT_TRANSPORT_WATCHDOG_MS
  let snapshotTrusted = false
  let connectionState: LiveConnectionState | undefined

  const setConnectionState = (status: LiveConnectionState['status'], trusted = snapshotTrusted) => {
    snapshotTrusted = trusted
    if (connectionState?.status === status && connectionState.snapshotTrusted === trusted) {
      return
    }
    connectionState = { status, snapshotTrusted: trusted }
    options.onConnectionChange?.(connectionState)
  }

  const clearTimer = (timer: Timer | undefined) => {
    if (timer !== undefined) {
      environment.clearTimeout(timer)
    }
  }

  const closeSource = () => {
    source?.close()
    source = undefined
    clearTimer(transportWatchdogTimer)
    transportWatchdogTimer = undefined
    clearTimer(snapshotWatchdogTimer)
    snapshotWatchdogTimer = undefined
  }

  const clearStaleTimer = () => {
    clearTimer(staleTimer)
    staleTimer = undefined
  }

  const markReconnecting = () => {
    setConnectionState('reconnecting')
    if (!snapshotTrusted || staleTimer !== undefined || options.scope !== 'room') {
      return
    }
    staleTimer = environment.setTimeout(() => {
      staleTimer = undefined
      setConnectionState('stale', false)
    }, ROOM_SNAPSHOT_WATCHDOG_MS)
  }

  const isCurrent = (eventGeneration: number, eventSource: EventSourceLike) => {
    return active && generation === eventGeneration && source === eventSource
  }

  const retryDelay = () => {
    failureCount += 1
    const exponential = Math.min(MAX_RETRY_MS, 500 * 2 ** (failureCount - 1))
    const jittered = Math.min(MAX_RETRY_MS, Math.round(exponential * (0.5 + environment.random())))
    if (environment.visibilityState() !== 'hidden') {
      return jittered
    }
    return options.scope === 'room' ? Math.min(jittered, HIDDEN_ROOM_MAX_RETRY_MS) : MAX_RETRY_MS
  }

  const scheduleRetry = (delayMs = retryDelay()) => {
    if (!active || blockedByTerminal || !environment.isOnline()) {
      return
    }
    clearTimer(retryTimer)
    retryTimer = environment.setTimeout(() => {
      retryTimer = undefined
      connect()
    }, delayMs)
  }

  const reconnectIfCurrent = (eventGeneration: number, eventSource: EventSourceLike) => {
    if (!isCurrent(eventGeneration, eventSource)) {
      return
    }
    markReconnecting()
    closeSource()
    if (!currentGenerationReceivedSnapshot) {
      if (!hasSuccessfulGeneration && startFallback()) {
        return
      }
      postSuccessFailureCount += 1
      if (postSuccessFailureCount >= POST_SUCCESS_FAILURES_BEFORE_FALLBACK && startFallback()) {
        return
      }
    }
    scheduleRetry()
  }

  const armTransportWatchdog = (eventGeneration: number, eventSource: EventSourceLike) => {
    clearTimer(transportWatchdogTimer)
    transportWatchdogTimer = environment.setTimeout(() => {
      reconnectIfCurrent(eventGeneration, eventSource)
    }, transportWatchdogMs)
  }

  const armSnapshotWatchdog = (eventGeneration: number, eventSource: EventSourceLike) => {
    if (options.scope !== 'room') {
      return
    }
    clearTimer(snapshotWatchdogTimer)
    snapshotWatchdogTimer = environment.setTimeout(() => {
      if (!isCurrent(eventGeneration, eventSource)) {
        return
      }
      clearStaleTimer()
      setConnectionState('stale', false)
      closeSource()
      scheduleRetry()
    }, ROOM_SNAPSHOT_WATCHDOG_MS)
  }

  const startFallback = () => {
    if (fallbackStarted || !options.onFallback) {
      return false
    }
    fallbackStarted = true
    blockedByTerminal = true
    closeSource()
    clearStaleTimer()
    setConnectionState('stale', false)
    options.onFallback()
    return true
  }

  const connect = () => {
    if (!active || blockedByTerminal || !environment.isOnline() || source) {
      return
    }
    markReconnecting()
    const eventGeneration = generation + 1
    generation = eventGeneration
    currentGenerationReceivedSnapshot = false
    let lastSnapshotPayload: string | undefined
    let eventSource: EventSourceLike
    try {
      eventSource = environment.createEventSource(options.url)
    } catch {
      if (!hasSuccessfulGeneration) {
        startFallback()
      } else {
        postSuccessFailureCount += 1
        if (postSuccessFailureCount >= POST_SUCCESS_FAILURES_BEFORE_FALLBACK) {
          startFallback()
        } else {
          scheduleRetry()
        }
      }
      return
    }
    source = eventSource

    const applySnapshot = (snapshot: T) => {
      const payload = JSON.stringify(snapshot)
      currentGenerationReceivedSnapshot = true
      hasSuccessfulGeneration = true
      postSuccessFailureCount = 0
      failureCount = 0
      clearStaleTimer()
      setConnectionState('live', true)
      armTransportWatchdog(eventGeneration, eventSource)
      armSnapshotWatchdog(eventGeneration, eventSource)
      if (payload === lastSnapshotPayload) {
        return
      }
      lastSnapshotPayload = payload
      options.onSnapshot(snapshot)
    }

    eventSource.addEventListener('ready', (event) => {
      if (!isCurrent(eventGeneration, eventSource)) {
        return
      }
      const ready = parseMessage<LiveReady>(event)
      if (!ready || ready.scope !== options.scope) {
        return
      }
      transportWatchdogMs = Math.max(ready.heartbeatMs * 2 + 1_000, ready.heartbeatMs + 1_000)
      armTransportWatchdog(eventGeneration, eventSource)
      armSnapshotWatchdog(eventGeneration, eventSource)
    })
    eventSource.addEventListener('heartbeat', (event) => {
      if (!isCurrent(eventGeneration, eventSource) || !parseMessage(event)) {
        return
      }
      armTransportWatchdog(eventGeneration, eventSource)
    })
    eventSource.addEventListener('snapshot', (event) => {
      if (!isCurrent(eventGeneration, eventSource)) {
        return
      }
      const message = parseMessage<LiveSnapshot<T>>(event)
      if (!message || message.scope !== options.scope) {
        return
      }
      applySnapshot(message.snapshot)
    })
    if (options.scope === 'room') {
      eventSource.addEventListener('room', (event) => {
        if (!isCurrent(eventGeneration, eventSource)) {
          return
        }
        const snapshot = parseLegacyMessage<T>(event)
        if (snapshot !== undefined) {
          applySnapshot(snapshot)
        }
      })
      eventSource.addEventListener('gone', () => {
        if (!isCurrent(eventGeneration, eventSource)) {
          return
        }
        closeSource()
        blockedByTerminal = true
        options.onTerminal?.({
          version: 1,
          code: 'not-found',
          reconnect: false,
        })
      })
    }
    eventSource.addEventListener('degraded', (event) => {
      if (isCurrent(eventGeneration, eventSource) && parseMessage(event)) {
        armTransportWatchdog(eventGeneration, eventSource)
      }
    })
    eventSource.addEventListener('terminal', (event) => {
      if (!isCurrent(eventGeneration, eventSource)) {
        return
      }
      const terminal = parseMessage<LiveTerminal>(event)
      if (!terminal) {
        return
      }
      closeSource()
      options.onTerminal?.({
        version: terminal.version,
        code: terminal.code,
        reconnect: terminal.reconnect,
      })
      if (terminal.reconnect) {
        markReconnecting()
        if (terminal.code === 'refresh') {
          failureCount = 0
        }
        scheduleRetry(terminal.code === 'refresh' ? 0 : undefined)
      } else {
        blockedByTerminal = true
        setConnectionState('stale', false)
      }
    })
    eventSource.addEventListener('error', () => {
      if (!isCurrent(eventGeneration, eventSource)) {
        return
      }
      reconnectIfCurrent(eventGeneration, eventSource)
    })
    armTransportWatchdog(eventGeneration, eventSource)
    armSnapshotWatchdog(eventGeneration, eventSource)
  }

  const removeOnline = environment.addOnlineListener(() => {
    if (active && !blockedByTerminal) {
      clearTimer(retryTimer)
      retryTimer = undefined
      connect()
    }
  })
  const removeOffline = environment.addOfflineListener(() => {
    clearTimer(retryTimer)
    retryTimer = undefined
    closeSource()
    clearStaleTimer()
    setConnectionState('stale', false)
  })
  const removeVisibility = environment.addVisibilityListener(() => {
    if (environment.visibilityState() === 'visible' && !source && environment.isOnline()) {
      clearTimer(retryTimer)
      retryTimer = undefined
      connect()
    }
  })
  connect()

  return {
    stop() {
      if (!active) {
        return
      }
      active = false
      generation += 1
      clearTimer(retryTimer)
      retryTimer = undefined
      clearStaleTimer()
      closeSource()
      removeOnline()
      removeOffline()
      removeVisibility()
    },
  }
}
