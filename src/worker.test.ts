import { describe, expect, it, vi } from 'vitest'
import { isRatingQueueMessage, processRatingQueueMessages } from './worker'

const validBody = { gameHistoryId: '0198fd3c-5ef0-7a08-9fd1-16dd758b2833' }

describe('rating queue payloads', () => {
  it('accept identifiers only', () => {
    expect(isRatingQueueMessage(validBody)).toBe(true)
    expect(
      isRatingQueueMessage({
        gameHistoryId: '0198fd3c-5ef0-7a08-9fd1-16dd758b2833',
        hands: [],
      }),
    ).toBe(false)
    expect(isRatingQueueMessage({ gameHistoryId: 'not-a-uuid' })).toBe(false)
  })

  it('acknowledges poison messages without delaying valid work', async () => {
    const poison = { body: { gameHistoryId: 'bad' }, ack: vi.fn(), retry: vi.fn() }
    const valid = { body: validBody, ack: vi.fn(), retry: vi.fn() }
    const reconcile = vi.fn().mockResolvedValue(1)

    await processRatingQueueMessages([poison, valid], reconcile, vi.fn())

    expect(poison.ack).toHaveBeenCalledOnce()
    expect(poison.retry).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledOnce()
    expect(valid.ack).toHaveBeenCalledOnce()
  })

  it('retries only the message whose reconciliation fails', async () => {
    const failed = { body: validBody, ack: vi.fn(), retry: vi.fn() }
    const succeeded = { body: validBody, ack: vi.fn(), retry: vi.fn() }
    const reconcile = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(1)

    const logError = vi.fn()
    await processRatingQueueMessages([failed, succeeded], reconcile, logError)

    expect(failed.retry).toHaveBeenCalledOnce()
    expect(failed.ack).not.toHaveBeenCalled()
    expect(succeeded.ack).toHaveBeenCalledOnce()
    expect(succeeded.retry).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('Rating queue reconciliation failed')
  })
})
