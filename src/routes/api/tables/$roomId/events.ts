import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { auth } from '../../../../lib/auth.server'
import { GameService, GameServiceError, gameRuntime } from '../../../../server/game-service.server'

export const Route = createFileRoute('/api/tables/$roomId/events')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session) return new Response('Unauthorized', { status: 401 })

        const presence = gameRuntime.runPromise(
          Effect.flatMap(GameService, (games) => games.setPresence(session.user.id, params.roomId, true)),
        )
        try {
          await presence
        } catch {
          return new Response('event: gone\ndata: {}\n\n', {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
            },
          })
        }

        const encoder = new TextEncoder()
        let timer: ReturnType<typeof setInterval> | undefined
        let closed = false
        let signature = ''
        let heartbeat = 0
        const close = () => {
          if (closed) return
          closed = true
          if (timer) clearInterval(timer)
        }
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const publish = async () => {
              if (closed) return
              try {
                const currentSession = await auth.api.getSession({ headers: request.headers })
                if (!currentSession || currentSession.user.id !== session.user.id) {
                  close()
                  controller.close()
                  return
                }
                const view = await gameRuntime.runPromise(Effect.flatMap(GameService, (games) => games.tick(session.user.id, params.roomId)))
                const nextSignature = `${view.version}:${view.status}:${view.seats.map((seat) => `${seat.connected}-${seat.controller}`).join(',')}:${view.disconnectVote?.approvals.join(',')}`
                if (signature !== nextSignature) {
                  signature = nextSignature
                  controller.enqueue(encoder.encode(`event: room\ndata: ${JSON.stringify(view)}\n\n`))
                }
                heartbeat += 1
                if (heartbeat % 15 === 0) controller.enqueue(encoder.encode(': heartbeat\n\n'))
              } catch (error) {
                if (error instanceof GameServiceError && (error.code === 'not-found' || error.code === 'forbidden')) {
                  controller.enqueue(encoder.encode('event: gone\ndata: {}\n\n'))
                  close()
                  controller.close()
                  return
                }
                try {
                  if (!closed) controller.enqueue(encoder.encode('event: error\ndata: {}\n\n'))
                } catch {
                  close()
                }
              }
            }
            request.signal.addEventListener('abort', () => {
              close()
            }, { once: true })
            await publish()
            if (!closed) timer = setInterval(() => void publish(), 500)
          },
          cancel: close,
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
