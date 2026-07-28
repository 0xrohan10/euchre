import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { createDb } from '../../../../db/index.server'
import { createAuth } from '../../../../lib/auth.server'
import {
  createGameRuntime,
  GameService,
  GameServiceError,
} from '../../../../server/game-service.server'
import { createRoomEventPublisher } from '../../../../server/room-event-publisher.server'

const activeStreams = new Map<string, symbol>()

export const Route = createFileRoute('/api/tables/$roomId/events')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        // Auth before the stream so we can 401 without hanging a Worker body.
        const database = createDb()
        const auth = createAuth(database)
        const session = await auth.api.getSession({ headers: request.headers })
        if (!session) {
          return new Response('Unauthorized', { status: 401 })
        }

        const roomId = params.roomId
        const userId = session.user.id
        const streamId = new URL(request.url).searchParams.get('stream') ?? crypto.randomUUID()
        const streamKey = `${userId}:${roomId}:${streamId}`
        const streamToken = Symbol()
        const encoder = new TextEncoder()
        const gameRuntime = createGameRuntime(database)
        let onCancel = () => {}

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false
            let publishing = false
            let timer: ReturnType<typeof setTimeout> | undefined
            activeStreams.set(streamKey, streamToken)

            const cleanup = () => {
              if (closed) {
                return
              }
              closed = true
              if (timer !== undefined) {
                clearTimeout(timer)
                timer = undefined
              }
              if (activeStreams.get(streamKey) === streamToken) {
                activeStreams.delete(streamKey)
              }
              void gameRuntime.dispose()
              try {
                controller.close()
              } catch {
                // already closed
              }
            }
            onCancel = cleanup

            const roomPublisher = createRoomEventPublisher((frame) => {
              controller.enqueue(encoder.encode(frame))
            }, cleanup)

            const send = (event: string, data?: unknown) => {
              if (closed) {
                return
              }
              const payload =
                data === undefined
                  ? `event: ${event}\ndata: \n\n`
                  : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
              try {
                controller.enqueue(encoder.encode(payload))
              } catch {
                cleanup()
              }
            }

            const publish = async () => {
              if (closed || publishing) {
                return
              }
              if (activeStreams.get(streamKey) !== streamToken) {
                cleanup()
                return
              }
              publishing = true
              try {
                const view = await gameRuntime.runPromise(
                  Effect.gen(function* () {
                    const games = yield* GameService
                    return yield* games.tick(userId, roomId)
                  }),
                )
                if (!closed) {
                  roomPublisher.publish(view)
                }
              } catch (error) {
                if (error instanceof GameServiceError && error.code === 'not-found') {
                  send('gone')
                  cleanup()
                  return
                }
                // Transient errors: keep the stream; the next tick may recover.
              } finally {
                publishing = false
              }
            }

            const schedule = () => {
              if (closed) {
                return
              }
              timer = setTimeout(() => {
                void publish().finally(schedule)
              }, 500)
            }

            request.signal.addEventListener('abort', cleanup, { once: true })

            // Enqueue immediately so workerd sees a live response before any DB I/O.
            try {
              controller.enqueue(encoder.encode(': connected\n\n'))
            } catch {
              cleanup()
              return
            }

            // Never block stream start on DB — that trips Workers hang detection in dev.
            // `tick` renews presence itself. Failed ticks are retried instead of tearing down
            // the EventSource, and stale-heartbeat detection handles abandoned connections.
            schedule()
          },
          cancel() {
            onCancel()
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        })
      },
    },
  },
})
