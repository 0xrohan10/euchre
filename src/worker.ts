import serverEntry from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'
import { createDb } from './db/index.server'
import {
  reconcilePendingRatings,
  type RatingQueueMessage,
} from './server/rating-reconciliation.server'
import {
  dispatchPendingRoomWakeups,
  installRoomWakeup,
  type RoomWakeupMessage,
} from './server/room-wakeup.server'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRatingQueueMessage(body: unknown): body is RatingQueueMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    Object.keys(body).length === 1 &&
    'gameHistoryId' in body &&
    typeof body.gameHistoryId === 'string' &&
    UUID_PATTERN.test(body.gameHistoryId)
  )
}

function isRoomWakeupMessage(body: unknown): body is RoomWakeupMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    Object.keys(body).length === 2 &&
    'roomId' in body &&
    typeof body.roomId === 'string' &&
    UUID_PATTERN.test(body.roomId) &&
    'generation' in body &&
    Number.isSafeInteger(body.generation) &&
    Number(body.generation) > 0
  )
}

type RatingQueueDelivery = {
  readonly body: unknown
  ack(): void
  retry(): void
}

async function processRatingQueueMessages(
  messages: readonly RatingQueueDelivery[],
  reconcile: () => Promise<unknown> = async () => {
    return reconcilePendingRatings(createDb(), 1)
  },
  logError: (message: string, error?: unknown) => void = console.error,
) {
  for (const message of messages) {
    if (!isRatingQueueMessage(message.body)) {
      logError('Discarding invalid rating queue message')
      message.ack()
      continue
    }
    try {
      await reconcile()
      message.ack()
    } catch {
      logError('Rating queue reconciliation failed')
      message.retry()
    }
  }
}

export default {
  fetch(request: Request) {
    return serverEntry.fetch(request)
  },
  async queue(batch: MessageBatch<RatingQueueMessage | RoomWakeupMessage>) {
    if (batch.queue === 'room-coordinator-wakeups') {
      for (const message of batch.messages) {
        if (!isRoomWakeupMessage(message.body)) {
          message.ack()
          continue
        }
        try {
          await installRoomWakeup(createDb(), env.ROOM_COORDINATOR, message.body)
          message.ack()
        } catch {
          message.retry()
        }
      }
      return
    }
    await processRatingQueueMessages(batch.messages as readonly RatingQueueDelivery[])
  },
  async scheduled() {
    const database = createDb()
    await Promise.allSettled([
      reconcilePendingRatings(database, 100),
      dispatchPendingRoomWakeups(database, env.ROOM_WAKEUP_QUEUE, 100),
    ])
  },
} satisfies ExportedHandler<Env, RatingQueueMessage | RoomWakeupMessage>

export { isRatingQueueMessage, isRoomWakeupMessage, processRatingQueueMessages }
export { LiveStreamAdmissionGate } from './server/live-stream-admission-do.server'
export { RoomCoordinator } from './server/room-coordinator-do.server'
