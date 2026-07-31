type Stoppable = {
  stop: () => void
}

export type LobbyLiveTransportOptions = {
  getVisibilityState: () => DocumentVisibilityState
  addVisibilityListener: (listener: () => void) => () => void
  startEvents: (onFallback: () => void) => Stoppable
  startPolling: () => Stoppable
}

export function startLobbyLiveTransport(options: LobbyLiveTransportOptions): Stoppable {
  let active = true
  let visibility = options.getVisibilityState()
  let mode: 'events' | 'polling' | undefined
  let events: Stoppable | undefined
  let polling: Stoppable | undefined

  const startPolling = () => {
    if (!active || mode === 'polling') {
      return
    }
    events?.stop()
    events = undefined
    mode = 'polling'
    polling = options.startPolling()
  }

  const startEvents = () => {
    if (!active || mode === 'events') {
      return
    }
    polling?.stop()
    polling = undefined
    mode = 'events'
    const started = options.startEvents(startPolling)
    if (mode === 'events') {
      events = started
    } else {
      started.stop()
    }
  }

  const onVisibilityChange = () => {
    const nextVisibility = options.getVisibilityState()
    if (!active || nextVisibility === visibility) {
      return
    }
    visibility = nextVisibility
    if (visibility === 'hidden') {
      if (mode === 'polling') {
        polling?.stop()
        polling = undefined
        mode = undefined
      }
      startPolling()
    } else {
      startEvents()
    }
  }

  const removeVisibilityListener = options.addVisibilityListener(onVisibilityChange)
  if (visibility === 'hidden') {
    startPolling()
  } else {
    startEvents()
  }

  return {
    stop() {
      if (!active) {
        return
      }
      active = false
      events?.stop()
      polling?.stop()
      removeVisibilityListener()
    },
  }
}
