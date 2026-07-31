import serverEntry from '@tanstack/react-start/server-entry'
import { createDb } from './db/index.server'
import {
  reconcilePendingRatings,
  type RatingQueueMessage,
} from './server/rating-reconciliation.server'

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
  async queue(batch: MessageBatch<RatingQueueMessage>) {
    await processRatingQueueMessages(batch.messages)
  },
  async scheduled() {
    try {
      await reconcilePendingRatings(createDb(), 100)
    } catch {
      console.error('Scheduled rating reconciliation failed')
    }
  },
} satisfies ExportedHandler<Env, RatingQueueMessage>

export { isRatingQueueMessage, processRatingQueueMessages }
