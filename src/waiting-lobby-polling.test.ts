import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { startWaitingLobbyPolling } from './waiting-lobby-polling'

type Snapshot = { party: unknown; room: unknown }

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('startWaitingLobbyPolling', () => {
  let visibility: DocumentVisibilityState
  let listeners: Array<() => void>
  let load: Mock<() => Promise<Snapshot>>
  let apply: Mock<(result: Snapshot) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    listeners = []
    load = vi.fn(async () => {
      return { party: { id: 'party' }, room: null }
    })
    apply = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function start() {
    return startWaitingLobbyPolling({
      load,
      apply,
      getVisibilityState: () => {
        return visibility
      },
      addVisibilityListener: (listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((entry) => {
            return entry !== listener
          })
        }
      },
      setTimeout: (callback, delayMs) => {
        return globalThis.setTimeout(callback, delayMs)
      },
      clearTimeout: (timer) => {
        globalThis.clearTimeout(timer)
      },
    })
  }

  function setVisibility(next: DocumentVisibilityState) {
    visibility = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  it('anchors visible cadence to request start times', async () => {
    const polling = start()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('does not overlap slow requests and catches up after settlement', async () => {
    const first = deferred<Snapshot>()
    load.mockImplementationOnce(() => {
      return first.promise
    })
    const polling = start()
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)

    first.resolve({ party: { id: 'party' }, room: null })
    await first.promise
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('uses a 15-second hidden cadence', async () => {
    const polling = start()
    await Promise.resolve()
    setVisibility('hidden')

    await vi.advanceTimersByTimeAsync(14_999)
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('waits for the hidden cadence before its first refresh when started hidden', async () => {
    visibility = 'hidden'
    const polling = start()

    await vi.advanceTimersByTimeAsync(14_999)
    expect(load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledOnce()

    polling.stop()
  })

  it('recovers after a rejected refresh', async () => {
    load.mockRejectedValueOnce(new Error('network'))
    const polling = start()
    await Promise.resolve()
    expect(apply).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)

    polling.stop()
  })

  it('wakes immediately when becoming visible while idle', async () => {
    const polling = start()
    await Promise.resolve()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(load).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('queues one pending refresh when becoming visible during an in-flight request', async () => {
    const first = deferred<Snapshot>()
    load.mockImplementationOnce(() => {
      return first.promise
    })
    const polling = start()
    expect(load).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    setVisibility('visible')
    setVisibility('hidden')
    setVisibility('visible')
    expect(load).toHaveBeenCalledTimes(1)

    first.resolve({ party: { id: 'party' }, room: null })
    await first.promise
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('replaces a pending visible timeout with a hidden timeout on hide', async () => {
    const polling = start()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(500)
    setVisibility('hidden')

    await vi.advanceTimersByTimeAsync(1_500)
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(13_500)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('anchors the next hidden start to hiddenAt when hiding during a deferred load', async () => {
    const first = deferred<Snapshot>()
    load.mockImplementationOnce(() => {
      return first.promise
    })
    const polling = start()
    expect(load).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(2_000)
    first.resolve({ party: { id: 'party' }, room: null })
    await first.promise
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    // hiddenAt was t=1000, so next start is t=16000; settlement was at t=3000.
    await vi.advanceTimersByTimeAsync(12_999)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    polling.stop()
  })

  it('stop prevents late apply and further scheduling', async () => {
    const first = deferred<Snapshot>()
    load.mockImplementationOnce(() => {
      return first.promise
    })
    const polling = start()
    polling.stop()

    first.resolve({ party: { id: 'party' }, room: null })
    await first.promise
    await Promise.resolve()
    expect(apply).toHaveBeenCalledTimes(0)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not apply when isCurrent becomes false before settlement', async () => {
    const first = deferred<Snapshot>()
    load.mockImplementationOnce(() => {
      return first.promise
    })
    let current = true
    const polling = startWaitingLobbyPolling({
      load,
      apply,
      isCurrent: () => {
        return current
      },
      getVisibilityState: () => {
        return visibility
      },
      addVisibilityListener: (listener) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((entry) => {
            return entry !== listener
          })
        }
      },
      setTimeout: (callback, delayMs) => {
        return globalThis.setTimeout(callback, delayMs)
      },
      clearTimeout: (timer) => {
        globalThis.clearTimeout(timer)
      },
    })

    current = false
    first.resolve({ party: { id: 'stale-party' }, room: null })
    await first.promise
    await Promise.resolve()
    expect(apply).toHaveBeenCalledTimes(0)

    polling.stop()
  })
})
