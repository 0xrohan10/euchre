export const LIVE_EVENT_PROTOCOL_VERSION = 1 as const

export type LiveEventScope = 'lobby' | 'room'
export type LiveTerminalCode =
  | 'expired'
  | 'forbidden'
  | 'not-found'
  | 'refresh'
  | 'replaced'
  | 'room-assigned'

export type LiveReady = {
  version: typeof LIVE_EVENT_PROTOCOL_VERSION
  scope: LiveEventScope
  heartbeatMs: number
  maxLifetimeMs: number
}

export type LiveSnapshot<T> = {
  version: typeof LIVE_EVENT_PROTOCOL_VERSION
  scope: LiveEventScope
  snapshot: T
}

export type LiveHeartbeat = {
  version: typeof LIVE_EVENT_PROTOCOL_VERSION
  at: number
}

export type LiveDegraded = {
  version: typeof LIVE_EVENT_PROTOCOL_VERSION
  attempt: number
  retryInMs: number
}

export type LiveTerminal = {
  version: typeof LIVE_EVENT_PROTOCOL_VERSION
  code: LiveTerminalCode
  reconnect: boolean
}

export type LiveEventData = {
  ready: LiveReady
  snapshot: LiveSnapshot<unknown>
  heartbeat: LiveHeartbeat
  degraded: LiveDegraded
  terminal: LiveTerminal
}

export type LiveEventName = keyof LiveEventData

export function frameLiveEvent<T extends LiveEventName>(event: T, data: LiveEventData[T]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function frameLegacyLiveEvent(event: 'room' | 'gone', data?: unknown): string {
  return data === undefined
    ? `event: ${event}\ndata: {}\n\n`
    : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function isProtocolMessage(value: unknown): value is { version: 1 } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === LIVE_EVENT_PROTOCOL_VERSION
  )
}
