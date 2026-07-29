import { createFileRoute } from '@tanstack/react-router'
import { liveEventHandlers } from '../../../server/live-event-handlers.server'

export const Route = createFileRoute('/api/lobby/events')({
  server: {
    handlers: {
      GET: ({ request }) => {
        return liveEventHandlers.lobby(request)
      },
    },
  },
})
