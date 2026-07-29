import { createFileRoute } from '@tanstack/react-router'
import { liveEventHandlers } from '../../../../server/live-event-handlers.server'

export const Route = createFileRoute('/api/tables/$roomId/events')({
  server: {
    handlers: {
      GET: ({ request, params }) => {
        return liveEventHandlers.room(request, params.roomId)
      },
    },
  },
})
