import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { RoomView } from '../multiplayer'
import { GameServiceError } from './game-service.server'
import { submitCommandResponse } from './command-response.server'

const room = { id: 'room-1', status: 'playing', version: 4 } as RoomView

describe('submit command response protocol', () => {
  it.each([undefined, 2] as const)(
    'preserves the successful RoomView shape for version %s',
    async (version) => {
      await expect(
        Effect.runPromise(
          submitCommandResponse(version, Effect.succeed(room), () => {
            return Effect.succeed(room)
          }),
        ),
      ).resolves.toBe(room)
    },
  )

  it('preserves stale-error rejection for an unversioned legacy request', async () => {
    const loadRoom = vi.fn(() => {
      return Effect.succeed(room)
    })
    const stale = new GameServiceError({ code: 'stale', message: 'stale' })

    await expect(
      Effect.runPromise(submitCommandResponse(undefined, Effect.fail(stale), loadRoom)),
    ).rejects.toBe(stale)
    expect(loadRoom).not.toHaveBeenCalled()
  })

  it('returns a typed stale wrapper only for a version 2 request', async () => {
    const stale = new GameServiceError({ code: 'stale', message: 'stale' })

    await expect(
      Effect.runPromise(
        submitCommandResponse(2, Effect.fail(stale), () => {
          return Effect.succeed(room)
        }),
      ),
    ).resolves.toEqual({ status: 'stale', room })
  })
})
