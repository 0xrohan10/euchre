import { Effect } from 'effect'
import type { RoomView } from '../multiplayer'
import { GameServiceError } from './game-service.server'

export function submitCommandResponse(
  responseVersion: 2 | undefined,
  submit: Effect.Effect<RoomView, GameServiceError>,
  loadRoom: () => Effect.Effect<RoomView, GameServiceError>,
) {
  if (responseVersion !== 2) {
    return submit
  }

  return submit.pipe(
    Effect.catchTag('GameServiceError', (error) => {
      return error.code === 'stale'
        ? Effect.map(loadRoom(), (room) => {
            return { status: 'stale' as const, room }
          })
        : Effect.fail(error)
    }),
  )
}
