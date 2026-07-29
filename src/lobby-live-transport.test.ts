import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLobbyLiveTransport } from './lobby-live-transport'
import { startWaitingLobbyPolling } from './waiting-lobby-polling'

describe('startLobbyLiveTransport', () => {
  let visibility: DocumentVisibilityState
  let visibilityListeners: Array<() => void>
  let eventStarts: number
  let eventStops: number
  let pollingLoads: number
  let fallback: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    visibility = 'visible'
    visibilityListeners = []
    eventStarts = 0
    eventStops = 0
    pollingLoads = 0
    fallback = () => {}
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const start = () => {
    return startLobbyLiveTransport({
      getVisibilityState: () => {
        return visibility
      },
      addVisibilityListener: (listener) => {
        visibilityListeners.push(listener)
        return () => {
          visibilityListeners = visibilityListeners.filter((candidate) => {
            return candidate !== listener
          })
        }
      },
      startEvents: (onFallback) => {
        eventStarts += 1
        fallback = onFallback
        return {
          stop() {
            eventStops += 1
          },
        }
      },
      startPolling: () => {
        return startWaitingLobbyPolling({
          load: async () => {
            pollingLoads += 1
            return undefined
          },
          apply: () => {},
          getVisibilityState: () => {
            return visibility
          },
          addVisibilityListener: () => {
            return () => {}
          },
          setTimeout: globalThis.setTimeout,
          clearTimeout: globalThis.clearTimeout,
        })
      },
    })
  }

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next
    for (const listener of [...visibilityListeners]) {
      listener()
    }
  }

  it('uses SSE only while visible and 15-second polling only while hidden', async () => {
    const transport = start()
    expect(eventStarts).toBe(1)
    expect(pollingLoads).toBe(0)

    setVisibility('hidden')
    expect(eventStops).toBe(1)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(pollingLoads).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(pollingLoads).toBe(1)

    setVisibility('visible')
    expect(eventStarts).toBe(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pollingLoads).toBe(1)

    transport.stop()
  })

  it('does not duplicate transports across repeated transitions or fallback', async () => {
    const transport = start()
    fallback()
    await vi.advanceTimersByTimeAsync(0)
    expect(pollingLoads).toBe(1)

    fallback()
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(eventStarts).toBe(1)
    expect(pollingLoads).toBe(2)

    setVisibility('hidden')
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(pollingLoads).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(pollingLoads).toBe(3)

    setVisibility('visible')
    setVisibility('visible')
    expect(eventStarts).toBe(2)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(pollingLoads).toBe(3)

    transport.stop()
  })
})
