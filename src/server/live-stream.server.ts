import {
  LIVE_EVENT_PROTOCOL_VERSION,
  frameLiveEvent,
  frameLegacyLiveEvent,
  type LiveEventScope,
  type LiveTerminalCode,
} from '../live-events'

export const LIVE_HEARTBEAT_MS = 15_000
export const LIVE_MAX_LIFETIME_MS = 5 * 60_000
export const LIVE_POLL_INTERVAL_MS = 500
export const LIVE_MAX_RETRY_MS = 30_000
export const LIVE_LOAD_TIMEOUT_MS = 10_000
export const LIVE_SNAPSHOT_PROGRESS_MS = 5_000
export const LIVE_ADMISSION_RETRY_WINDOW_MS = 40_000

type Timer = ReturnType<typeof globalThis.setTimeout>

export type LiveStreamTimers = {
  setTimeout: (callback: () => void, delayMs: number) => Timer
  clearTimeout: (timer: Timer) => void
  now: () => number
  random: () => number
}

export type LiveStreamError = {
  code: Extract<LiveTerminalCode, 'forbidden' | 'not-found'>
}

export type LiveAdmissionRenewal = 'active' | 'expired' | 'replaced'

export type LiveStreamOptions<T> = {
  request: Pick<Request, 'signal'>
  scope: LiveEventScope
  loadSnapshot: () => Promise<T>
  terminalAfterSnapshot?: (snapshot: T) => LiveTerminalCode | undefined
  classifyError?: (error: unknown) => LiveStreamError | undefined
  onCleanup?: () => void | Promise<void>
  releaseAdmissionOnce?: () => void | Promise<void>
  releaseAdmission?: () => void | Promise<void>
  waitUntil?: (promise: Promise<void>) => void
  registerCleanup?: (cleanup: () => void, replace: () => void) => () => void
  renewAdmission?: () => Promise<LiveAdmissionRenewal>
  legacyMaxLifetime?: boolean
  heartbeatMs?: number
  maxLifetimeMs?: number
  pollIntervalMs?: number
  maxRetryMs?: number
  loadTimeoutMs?: number
  snapshotProgressMs?: number
  timers?: LiveStreamTimers
}

const defaultTimers: LiveStreamTimers = {
  setTimeout: (callback, delayMs) => {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout: (timer) => {
    globalThis.clearTimeout(timer)
  },
  now: () => {
    return Date.now()
  },
  random: () => {
    return Math.random()
  },
}

function retryDelay(
  attempt: number,
  baseDelayMs: number,
  maximum: number,
  random: () => number,
): number {
  const exponential = Math.min(maximum, baseDelayMs * 2 ** (attempt - 1))
  return Math.min(maximum, Math.round(exponential * (0.5 + random())))
}

export function createLiveSnapshotResponse<T>(options: LiveStreamOptions<T>): Response {
  const timers = options.timers ?? defaultTimers
  const heartbeatMs = options.heartbeatMs ?? LIVE_HEARTBEAT_MS
  const maxLifetimeMs = options.maxLifetimeMs ?? LIVE_MAX_LIFETIME_MS
  const pollIntervalMs = options.pollIntervalMs ?? LIVE_POLL_INTERVAL_MS
  const maxRetryMs = options.maxRetryMs ?? LIVE_MAX_RETRY_MS
  const loadTimeoutMs = options.loadTimeoutMs ?? LIVE_LOAD_TIMEOUT_MS
  const snapshotProgressMs = options.snapshotProgressMs ?? LIVE_SNAPSHOT_PROGRESS_MS
  const encoder = new TextEncoder()
  let cancel = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let cleanupStarted = false
      let failureCount = 0
      let admissionFailureCount = 0
      let releaseFailureCount = 0
      let admissionRetryDeadline = timers.now() + LIVE_ADMISSION_RETRY_WINDOW_MS
      let lastSnapshot: string | undefined
      let lastSnapshotAt = Number.NEGATIVE_INFINITY
      let pollTimer: Timer | undefined
      let heartbeatTimer: Timer | undefined
      let lifetimeTimer: Timer | undefined
      let refreshTimer: Timer | undefined
      let unregister = () => {}
      let pendingLoad: Promise<T> | undefined
      let refreshRequested = false
      let refreshDraining = false
      let releaseInFlight = false
      let admissionReleased = false

      const clearTimer = (timer: Timer | undefined) => {
        if (timer !== undefined) {
          timers.clearTimeout(timer)
        }
      }

      const cleanup = (releaseAdmission = true, disposeConnection = true) => {
        if (cleanupStarted) {
          return
        }
        cleanupStarted = true
        closed = true
        try {
          controller.close()
        } catch {
          // Cancellation may have already closed the controller.
        }
        clearTimer(pollTimer)
        clearTimer(heartbeatTimer)
        clearTimer(lifetimeTimer)
        clearTimer(refreshTimer)
        const loadAtCleanup = pendingLoad
        options.request.signal.removeEventListener('abort', close)
        unregister()
        if (
          (disposeConnection && options.onCleanup) ||
          (releaseAdmission && options.releaseAdmission)
        ) {
          const settledLoad = loadAtCleanup
            ? loadAtCleanup.then(
                () => {},
                () => {},
              )
            : Promise.resolve()
          const dispose = settledLoad.then(() => {
            return disposeConnection ? options.onCleanup?.() : undefined
          })
          const release =
            releaseAdmission && options.releaseAdmission
              ? dispose.then(options.releaseAdmission, options.releaseAdmission)
              : dispose
          options.waitUntil?.(release)
        }
      }
      const close = () => {
        cleanup()
      }
      cancel = close

      const send = (frame: string): boolean => {
        if (closed) {
          return false
        }
        try {
          controller.enqueue(encoder.encode(frame))
          return true
        } catch {
          close()
          return false
        }
      }

      const terminal = (code: LiveTerminalCode, reconnect: boolean, releaseAdmission = true) => {
        send(
          frameLiveEvent('terminal', {
            version: LIVE_EVENT_PROTOCOL_VERSION,
            code,
            reconnect,
          }),
        )
        if (options.scope === 'room' && (code === 'not-found' || code === 'forbidden')) {
          send(frameLegacyLiveEvent('gone'))
        }
        cleanup(releaseAdmission)
      }
      unregister =
        options.registerCleanup?.(close, () => {
          terminal('replaced', false)
        }) ?? unregister

      const loadWithTimeout = () => {
        const load =
          pendingLoad ??
          (() => {
            const started = options.loadSnapshot()
            pendingLoad = started
            void started.then(
              () => {
                if (pendingLoad === started) {
                  pendingLoad = undefined
                }
              },
              () => {
                if (pendingLoad === started) {
                  pendingLoad = undefined
                }
              },
            )
            return started
          })()
        return new Promise<T>((resolve, reject) => {
          let settled = false
          const timeout = timers.setTimeout(() => {
            if (!settled) {
              settled = true
              reject(new Error('Live snapshot load timed out'))
            }
          }, loadTimeoutMs)
          void load.then(
            (snapshot) => {
              if (!settled) {
                settled = true
                timers.clearTimeout(timeout)
                resolve(snapshot)
              }
            },
            (error: unknown) => {
              if (!settled) {
                settled = true
                timers.clearTimeout(timeout)
                reject(error)
              }
            },
          )
        })
      }

      const scheduleHeartbeat = (delayMs = heartbeatMs) => {
        heartbeatTimer = timers.setTimeout(() => {
          void (async () => {
            if (options.renewAdmission) {
              let admission: LiveAdmissionRenewal
              try {
                admission = await options.renewAdmission()
              } catch {
                if (closed || admissionReleased) {
                  return
                }
                admissionFailureCount += 1
                const remainingMs = admissionRetryDeadline - timers.now()
                if (remainingMs <= 0) {
                  terminal('expired', true)
                  return
                }
                const retryInMs = Math.min(
                  remainingMs,
                  retryDelay(admissionFailureCount, pollIntervalMs, maxRetryMs, timers.random),
                )
                if (
                  send(
                    frameLiveEvent('degraded', {
                      version: LIVE_EVENT_PROTOCOL_VERSION,
                      attempt: admissionFailureCount,
                      retryInMs,
                    }),
                  )
                ) {
                  scheduleHeartbeat(retryInMs)
                }
                return
              }
              if (closed || admissionReleased) {
                return
              }
              if (admission !== 'active') {
                terminal(admission, admission === 'expired')
                return
              }
              admissionFailureCount = 0
              admissionRetryDeadline = timers.now() + LIVE_ADMISSION_RETRY_WINDOW_MS
            }
            if (
              send(
                frameLiveEvent('heartbeat', {
                  version: LIVE_EVENT_PROTOCOL_VERSION,
                  at: timers.now(),
                }),
              )
            ) {
              scheduleHeartbeat()
            }
          })()
        }, delayMs)
      }

      const schedulePoll = (delayMs: number) => {
        if (closed || admissionReleased || refreshDraining || pollTimer !== undefined) {
          return
        }
        pollTimer = timers.setTimeout(() => {
          pollTimer = undefined
          if (closed || admissionReleased || refreshDraining) {
            return
          }
          void publish()
        }, delayMs)
      }

      const publish = async () => {
        if (closed || admissionReleased || refreshDraining) {
          return
        }
        try {
          const snapshot = await loadWithTimeout()
          if (closed) {
            return
          }
          failureCount = 0
          const payload = JSON.stringify(snapshot)
          if (payload !== lastSnapshot || timers.now() - lastSnapshotAt >= snapshotProgressMs) {
            const sent = send(
              frameLiveEvent('snapshot', {
                version: LIVE_EVENT_PROTOCOL_VERSION,
                scope: options.scope,
                snapshot,
              }),
            )
            if (!sent) {
              return
            }
            if (options.scope === 'room') {
              send(frameLegacyLiveEvent('room', snapshot))
            }
            lastSnapshot = payload
            lastSnapshotAt = timers.now()
          }
          const terminalCode = options.terminalAfterSnapshot?.(snapshot)
          if (terminalCode) {
            terminal(terminalCode, false)
            return
          }
          schedulePoll(pollIntervalMs)
        } catch (error) {
          if (closed) {
            return
          }
          const classified = options.classifyError?.(error)
          if (classified) {
            terminal(classified.code, false)
            return
          }
          failureCount += 1
          const retryInMs = retryDelay(failureCount, pollIntervalMs, maxRetryMs, timers.random)
          if (
            send(
              frameLiveEvent('degraded', {
                version: LIVE_EVENT_PROTOCOL_VERSION,
                attempt: failureCount,
                retryInMs,
              }),
            )
          ) {
            const load = pendingLoad
            if (load) {
              void load.then(
                () => {
                  if (!closed) {
                    schedulePoll(retryInMs)
                  }
                },
                () => {
                  if (!closed) {
                    schedulePoll(retryInMs)
                  }
                },
              )
            } else {
              schedulePoll(retryInMs)
            }
          }
        }
      }

      const finishRefresh = () => {
        if (options.legacyMaxLifetime) {
          cleanup(false)
          return
        }
        terminal('refresh', true, false)
      }

      const releaseForRefresh = async () => {
        if (
          closed ||
          !refreshRequested ||
          refreshDraining ||
          releaseInFlight ||
          admissionReleased
        ) {
          return
        }
        refreshDraining = true
        clearTimer(pollTimer)
        pollTimer = undefined
        let releaseRetryInMs: number | undefined
        try {
          const load = pendingLoad
          if (load) {
            await load.then(
              () => {},
              () => {},
            )
          }
          if (closed) {
            return
          }
          releaseInFlight = true
          await options.releaseAdmissionOnce?.()
          if (closed) {
            return
          }
          admissionReleased = true
          clearTimer(heartbeatTimer)
          heartbeatTimer = undefined
          finishRefresh()
        } catch {
          if (closed) {
            return
          }
          releaseFailureCount += 1
          const retryInMs = retryDelay(
            releaseFailureCount,
            pollIntervalMs,
            maxRetryMs,
            timers.random,
          )
          if (
            send(
              frameLiveEvent('degraded', {
                version: LIVE_EVENT_PROTOCOL_VERSION,
                attempt: releaseFailureCount,
                retryInMs,
              }),
            )
          ) {
            releaseRetryInMs = retryInMs
          }
        } finally {
          releaseInFlight = false
          if (!closed && !admissionReleased) {
            refreshDraining = false
            schedulePoll(pollIntervalMs)
            if (releaseRetryInMs !== undefined) {
              refreshTimer = timers.setTimeout(() => {
                refreshTimer = undefined
                void releaseForRefresh()
              }, releaseRetryInMs)
            }
          }
        }
      }

      options.request.signal.addEventListener('abort', close, { once: true })
      send(
        frameLiveEvent('ready', {
          version: LIVE_EVENT_PROTOCOL_VERSION,
          scope: options.scope,
          heartbeatMs,
          maxLifetimeMs,
        }),
      )
      scheduleHeartbeat()
      lifetimeTimer = timers.setTimeout(() => {
        refreshRequested = true
        void releaseForRefresh()
      }, maxLifetimeMs)
      schedulePoll(0)
    },
    cancel() {
      cancel()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
