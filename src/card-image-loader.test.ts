import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  warmCardImages,
  type CardImageLoaderDependencies,
  type CardImageSessionCache,
} from './card-image-loader'

type TestImage = Pick<HTMLImageElement, 'fetchPriority' | 'onerror' | 'onload' | 'src'> & {
  removed: boolean
}

function createSessionCache(): CardImageSessionCache {
  return { completedUrls: new Set<string>(), inFlightUrls: new Set<string>() }
}

function createTestImage(): TestImage {
  return {
    fetchPriority: 'auto',
    onerror: null,
    onload: null,
    removed: false,
    src: '',
  }
}

function dispatch(image: TestImage, event: 'error' | 'load') {
  image[`on${event}`]?.call(image as HTMLImageElement, new Event(event))
}

function loaderHarness() {
  const images: TestImage[] = []
  const scheduled = new Map<
    number,
    { callback: IdleRequestCallback; options: IdleRequestOptions }
  >()
  const cancelled: unknown[] = []
  let nextHandle = 0
  const dependencies: CardImageLoaderDependencies = {
    createImage: () => {
      const image = createTestImage()
      images.push(image)
      return image
    },
    cancelImage: (image) => {
      const testImage = image as TestImage
      testImage.removed = true
      testImage.src = ''
    },
    scheduleIdle: (callback, options) => {
      const handle = nextHandle
      nextHandle += 1
      scheduled.set(handle, { callback, options })
      return handle
    },
    cancelIdle: (handle) => {
      cancelled.push(handle)
      scheduled.delete(handle as number)
    },
  }
  const runNext = (
    deadline: IdleDeadline = {
      didTimeout: false,
      timeRemaining: () => {
        return 50
      },
    },
  ) => {
    const entry = scheduled.entries().next().value as
      | [number, { callback: IdleRequestCallback; options: IdleRequestOptions }]
      | undefined
    if (!entry) {
      return
    }
    scheduled.delete(entry[0])
    entry[1].callback(deadline)
  }
  return { cancelled, dependencies, images, runNext, scheduled }
}

function requestedImages(images: TestImage[]) {
  return images.map(({ fetchPriority, src }) => {
    return { fetchPriority, src }
  })
}

describe('warmCardImages', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads deduplicated visible cards immediately and defers bounded low-priority batches', () => {
    const harness = loaderHarness()
    warmCardImages(
      {
        priorityUrls: ['hand-1.svg', 'hand-1.svg', 'up-card.svg'],
        deferredUrls: ['hand-1.svg', 'face-1.svg', 'face-1.svg', 'face-2.svg', 'face-3.svg'],
        batchSize: 2,
      },
      harness.dependencies,
    )

    expect(requestedImages(harness.images)).toEqual([
      { fetchPriority: 'high', src: 'hand-1.svg' },
      { fetchPriority: 'high', src: 'up-card.svg' },
    ])
    expect(harness.scheduled.get(0)?.options).toEqual({ timeout: 1_000 })

    harness.runNext()
    expect(requestedImages(harness.images.slice(2))).toEqual([
      { fetchPriority: 'low', src: 'face-1.svg' },
      { fetchPriority: 'low', src: 'face-2.svg' },
    ])

    harness.runNext()
    expect(requestedImages(harness.images).at(-1)).toEqual({
      fetchPriority: 'low',
      src: 'face-3.svg',
    })
    expect(harness.scheduled.size).toBe(0)
  })

  it('marks a URL complete only after a successful load and skips it on remount', () => {
    const harness = loaderHarness()
    const sessionCache = createSessionCache()
    const first = warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )

    expect(sessionCache.completedUrls).toEqual(new Set())
    expect(sessionCache.inFlightUrls).toEqual(new Set(['face.svg']))
    dispatch(harness.images[0], 'load')
    expect(sessionCache.completedUrls).toEqual(new Set(['face.svg']))
    expect(sessionCache.inFlightUrls).toEqual(new Set())
    first.stop()

    warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )
    expect(harness.images).toHaveLength(1)
  })

  it('retries a transient failure on a later mount', () => {
    const harness = loaderHarness()
    const sessionCache = createSessionCache()
    warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )
    dispatch(harness.images[0], 'error')

    expect(sessionCache.completedUrls).toEqual(new Set())
    expect(sessionCache.inFlightUrls).toEqual(new Set())
    warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )

    expect(requestedImages(harness.images)).toEqual([
      { fetchPriority: 'high', src: 'face.svg' },
      { fetchPriority: 'high', src: 'face.svg' },
    ])
  })

  it('cancels an in-flight image and allows a remount to retry it', () => {
    const harness = loaderHarness()
    const sessionCache = createSessionCache()
    const first = warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )
    first.stop()

    expect(harness.images[0].removed).toBe(true)
    expect(sessionCache.completedUrls).toEqual(new Set())
    expect(sessionCache.inFlightUrls).toEqual(new Set())
    warmCardImages(
      { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache },
      harness.dependencies,
    )
    expect(harness.images).toHaveLength(2)
  })

  it('does not duplicate a request while another warmup has it in flight', () => {
    const harness = loaderHarness()
    const sessionCache = createSessionCache()
    const options = { priorityUrls: ['face.svg'], deferredUrls: [], sessionCache }

    warmCardImages(options, harness.dependencies)
    warmCardImages(options, harness.dependencies)

    expect(harness.images).toHaveLength(1)
    expect(sessionCache.inFlightUrls).toEqual(new Set(['face.svg']))
  })

  it('reschedules when the browser reports no idle deadline budget', () => {
    const harness = loaderHarness()
    warmCardImages({ priorityUrls: [], deferredUrls: ['face.svg'] }, harness.dependencies)

    harness.runNext({
      didTimeout: false,
      timeRemaining: () => {
        return 0
      },
    })

    expect(harness.images).toEqual([])
    expect(harness.scheduled.get(1)?.options).toEqual({ timeout: 1_000 })
  })

  it('loads a bounded batch when a real idle callback times out', () => {
    const harness = loaderHarness()
    warmCardImages(
      { priorityUrls: [], deferredUrls: ['face-1.svg', 'face-2.svg'], batchSize: 1 },
      harness.dependencies,
    )

    harness.runNext({
      didTimeout: true,
      timeRemaining: () => {
        return 0
      },
    })

    expect(requestedImages(harness.images)).toEqual([{ fetchPriority: 'low', src: 'face-1.svg' }])
    expect(harness.scheduled.size).toBe(1)
  })

  it('paces the timer fallback in small non-timeout batches', async () => {
    vi.useFakeTimers()
    const images: TestImage[] = []
    class ImageStub {
      constructor() {
        const image = createTestImage()
        images.push(image)
        return image
      }
    }
    vi.stubGlobal('Image', ImageStub)
    vi.stubGlobal('window', {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    })

    warmCardImages({
      priorityUrls: [],
      deferredUrls: Array.from({ length: 24 }, (_, index) => {
        return `face-${index}.svg`
      }),
    })

    await vi.advanceTimersByTimeAsync(199)
    expect(images).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(101)
    expect(images).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(900)
    expect(images).toHaveLength(12)
  })

  it('cancels pending idle work exactly once', () => {
    const harness = loaderHarness()
    const warmup = warmCardImages(
      { priorityUrls: [], deferredUrls: ['face.svg'] },
      harness.dependencies,
    )

    warmup.stop()
    warmup.stop()

    expect(harness.cancelled).toEqual([0])
    expect(harness.scheduled.size).toBe(0)
    expect(harness.images).toEqual([])
  })

  it('is inert without browser dependencies', () => {
    expect(() => {
      warmCardImages({ priorityUrls: ['face.svg'], deferredUrls: [] }, null).stop()
    }).not.toThrow()
  })
})
