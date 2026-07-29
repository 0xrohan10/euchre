export type CardImageLoaderDependencies = {
  createImage: () => Pick<HTMLImageElement, 'fetchPriority' | 'onerror' | 'onload' | 'src'>
  cancelImage: (
    image: Pick<HTMLImageElement, 'fetchPriority' | 'onerror' | 'onload' | 'src'>,
  ) => void
  scheduleIdle: (callback: IdleRequestCallback, options: IdleRequestOptions) => unknown
  cancelIdle: (handle: unknown) => void
  maxBatchSize?: number
}

export type CardImageSessionCache = {
  completedUrls: Set<string>
  inFlightUrls: Set<string>
}

export type CardImageWarmup = {
  stop: () => void
}

const idleTimeoutMs = 1_000
const fallbackBatchSize = 2
const fallbackDelayMs = 200

function browserDependencies(): CardImageLoaderDependencies | null {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return null
  }

  if (
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    return {
      createImage: () => {
        return new Image()
      },
      cancelImage: (image) => {
        ;(image as HTMLImageElement).removeAttribute('src')
      },
      scheduleIdle: (callback, options) => {
        return window.requestIdleCallback(callback, options)
      },
      cancelIdle: (handle) => {
        return window.cancelIdleCallback(handle as number)
      },
    }
  }

  return {
    createImage: () => {
      return new Image()
    },
    cancelImage: (image) => {
      ;(image as HTMLImageElement).removeAttribute('src')
    },
    scheduleIdle: (callback) => {
      return window.setTimeout(() => {
        callback({
          didTimeout: false,
          timeRemaining: () => {
            return 1
          },
        })
      }, fallbackDelayMs)
    },
    cancelIdle: (handle) => {
      return window.clearTimeout(handle as number)
    },
    maxBatchSize: fallbackBatchSize,
  }
}

export function warmCardImages(
  {
    priorityUrls,
    deferredUrls,
    batchSize = 4,
    sessionCache = { completedUrls: new Set<string>(), inFlightUrls: new Set<string>() },
  }: {
    priorityUrls: readonly string[]
    deferredUrls: readonly string[]
    batchSize?: number
    sessionCache?: CardImageSessionCache
  },
  dependencies: CardImageLoaderDependencies | null = browserDependencies(),
): CardImageWarmup {
  if (!dependencies || batchSize < 1) {
    return { stop: () => {} }
  }

  const effectiveBatchSize = Math.min(batchSize, dependencies.maxBatchSize ?? batchSize)
  const ownedLoads = new Map<
    string,
    Pick<HTMLImageElement, 'fetchPriority' | 'onerror' | 'onload' | 'src'>
  >()
  let stopped = false
  const load = (url: string, priority: 'high' | 'low') => {
    if (
      !url ||
      stopped ||
      sessionCache.completedUrls.has(url) ||
      sessionCache.inFlightUrls.has(url)
    ) {
      return
    }
    sessionCache.inFlightUrls.add(url)
    const image = dependencies.createImage()
    const settle = (completed: boolean) => {
      image.onload = null
      image.onerror = null
      ownedLoads.delete(url)
      sessionCache.inFlightUrls.delete(url)
      if (completed && !stopped) {
        sessionCache.completedUrls.add(url)
      }
    }
    image.onload = () => {
      settle(true)
    }
    image.onerror = () => {
      settle(false)
    }
    image.fetchPriority = priority
    ownedLoads.set(url, image)
    image.src = url
  }

  for (const url of priorityUrls) {
    load(url, 'high')
  }

  const queue = [...new Set(deferredUrls)].filter((url) => {
    return url && !sessionCache.completedUrls.has(url) && !sessionCache.inFlightUrls.has(url)
  })
  let idleHandle: unknown
  const scheduleBatch = () => {
    idleHandle = dependencies.scheduleIdle(runBatch, { timeout: idleTimeoutMs })
  }
  const runBatch: IdleRequestCallback = (deadline) => {
    idleHandle = undefined
    if (stopped) {
      return
    }
    let loaded = 0
    while (
      queue.length > 0 &&
      loaded < effectiveBatchSize &&
      (deadline.didTimeout || deadline.timeRemaining() > 0)
    ) {
      load(queue.shift() ?? '', 'low')
      loaded += 1
    }
    if (queue.length > 0) {
      scheduleBatch()
    }
  }

  if (queue.length > 0) {
    scheduleBatch()
  }

  return {
    stop: () => {
      if (stopped) {
        return
      }
      stopped = true
      if (idleHandle !== undefined) {
        dependencies.cancelIdle(idleHandle)
        idleHandle = undefined
      }
      for (const [url, image] of ownedLoads) {
        image.onload = null
        image.onerror = null
        sessionCache.inFlightUrls.delete(url)
        dependencies.cancelImage(image)
      }
      ownedLoads.clear()
    },
  }
}
