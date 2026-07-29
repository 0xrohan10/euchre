export type WaitingLobbyTimer = ReturnType<typeof globalThis.setTimeout>

export type WaitingLobbyPollingOptions<T> = {
  load: () => Promise<T>
  apply: (result: T) => void
  getVisibilityState: () => DocumentVisibilityState
  addVisibilityListener: (listener: () => void) => () => void
  setTimeout: (callback: () => void, delayMs: number) => WaitingLobbyTimer
  clearTimeout: (timer: WaitingLobbyTimer) => void
  /** When this returns false, a settled load must not call apply. */
  isCurrent?: () => boolean
  now?: () => number
  visibleIntervalMs?: number
  hiddenIntervalMs?: number
}

export type WaitingLobbyPolling = {
  stop: () => void
}

const VISIBLE_INTERVAL_MS = 2_000
const HIDDEN_INTERVAL_MS = 15_000

export function startWaitingLobbyPolling<T>(
  options: WaitingLobbyPollingOptions<T>,
): WaitingLobbyPolling {
  const now = options.now ?? Date.now
  const visibleIntervalMs = options.visibleIntervalMs ?? VISIBLE_INTERVAL_MS
  const hiddenIntervalMs = options.hiddenIntervalMs ?? HIDDEN_INTERVAL_MS
  const isCurrent =
    options.isCurrent ??
    (() => {
      return true
    })

  let active = true
  let epoch = 0
  let timer: WaitingLobbyTimer | undefined
  let inFlight = false
  let refreshPending = false
  let hiddenAt: number | undefined
  let startedAt = 0

  const clearTimer = () => {
    if (timer !== undefined) {
      options.clearTimeout(timer)
      timer = undefined
    }
  }

  const canApply = (requestEpoch: number) => {
    return active && requestEpoch === epoch && isCurrent()
  }

  const scheduleAt = (targetStart: number) => {
    if (!active || inFlight) {
      return
    }
    clearTimer()
    const delay = Math.max(0, targetStart - now())
    timer = options.setTimeout(() => {
      timer = undefined
      void runRefresh()
    }, delay)
  }

  const scheduleAfterSettlement = () => {
    if (!active) {
      return
    }
    if (refreshPending) {
      refreshPending = false
      void runRefresh()
      return
    }
    const visibility = options.getVisibilityState()
    if (visibility === 'hidden') {
      const target = (hiddenAt ?? now()) + hiddenIntervalMs
      scheduleAt(target)
      return
    }
    scheduleAt(startedAt + visibleIntervalMs)
  }

  const runRefresh = async () => {
    if (!active || inFlight) {
      return
    }
    inFlight = true
    const requestEpoch = epoch
    startedAt = now()
    clearTimer()
    try {
      const result = await options.load()
      if (!canApply(requestEpoch)) {
        return
      }
      options.apply(result)
    } catch {
      // Preserve current resilience: keep polling after failures.
    } finally {
      inFlight = false
      if (active) {
        scheduleAfterSettlement()
      }
    }
  }

  const onVisibilityChange = () => {
    if (!active) {
      return
    }
    const visibility = options.getVisibilityState()
    if (visibility === 'visible') {
      hiddenAt = undefined
      if (inFlight) {
        refreshPending = true
        return
      }
      clearTimer()
      void runRefresh()
      return
    }

    hiddenAt = now()
    refreshPending = false
    if (inFlight) {
      return
    }
    clearTimer()
    scheduleAt(hiddenAt + hiddenIntervalMs)
  }

  const removeVisibilityListener = options.addVisibilityListener(onVisibilityChange)
  if (options.getVisibilityState() === 'hidden') {
    hiddenAt = now()
    scheduleAt(hiddenAt + hiddenIntervalMs)
  } else {
    void runRefresh()
  }

  return {
    stop() {
      if (!active) {
        return
      }
      active = false
      epoch += 1
      clearTimer()
      removeVisibilityListener()
    },
  }
}
