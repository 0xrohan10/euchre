import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { authMiddleware } from '../lib/auth.middleware'
import {
  createRoomInput,
  joinPartyInput,
  joinRoomInput,
  roomCreationInput,
  roomIdInput,
  rulesInput,
  submitCommandInput,
  voteForBotInput,
} from '../lib/game.validation'
import { GameService } from './game-service.server'
import { submitCommandResponse } from './command-response.server'
import { pokeRoomCoordinator } from './room-coordinator-poke.server'

async function pokeAfterCommit<T>(roomId: string, committed: Promise<T>): Promise<T> {
  const result = await committed
  try {
    pokeRoomCoordinator(roomId)
  } catch {
    // A coordinator signal is only a latency optimization; PostgreSQL is authoritative.
  }
  return result
}

export const createRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(createRoomInput)
  .handler(({ data, context }) => {
    const operationId = data.operationId ?? crypto.randomUUID()
    if (data.legacy) {
      return context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.createRoom(context.session.user.id, operationId, data.rules)
        }),
      )
    }
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        const creation = games.createRoom(context.session.user.id, operationId, data.rules)
        return creation.pipe(
          Effect.map((room) => {
            return { outcome: 'created' as const, room }
          }),
          Effect.catchTag('GameServiceError', (error) => {
            if (error.code === 'database') {
              return Effect.fail(error)
            }
            return Effect.flatMap(
              games.hasRoomCreationOperation(context.session.user.id, operationId),
              (recorded) => {
                return recorded
                  ? Effect.fail(error)
                  : Effect.succeed({ outcome: 'rejected' as const })
              },
            )
          }),
        )
      }),
    )
  })

export const createSinglePlayerRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(createRoomInput)
  .handler(({ data, context }) => {
    const operationId = data.operationId ?? crypto.randomUUID()
    if (data.legacy) {
      return context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.createSinglePlayerRoom(context.session.user.id, operationId, data.rules)
        }),
      )
    }
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        const creation = games.createSinglePlayerRoom(
          context.session.user.id,
          operationId,
          data.rules,
        )
        return creation.pipe(
          Effect.map((room) => {
            return { outcome: 'created' as const, room }
          }),
          Effect.catchTag('GameServiceError', (error) => {
            if (error.code === 'database') {
              return Effect.fail(error)
            }
            return Effect.flatMap(
              games.hasRoomCreationOperation(context.session.user.id, operationId),
              (recorded) => {
                return recorded
                  ? Effect.fail(error)
                  : Effect.succeed({ outcome: 'rejected' as const })
              },
            )
          }),
        )
      }),
    )
  })

export const getRoomForCreationFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(roomCreationInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.roomForCreationOperation(context.session.user.id, data.operationId, data.kind)
      }),
    )
  })

export const getCurrentPartyFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.currentParty(context.session.user.id)
      }),
    )
  })

export const createPartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createParty(context.session.user.id)
      }),
    )
  })

export const joinPartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(joinPartyInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinParty(context.session.user.id, data.inviteCode)
      }),
    )
  })

export const leavePartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.leaveParty(context.session.user.id)
      }),
    )
  })

export const startPartyRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.startPartyRoom(context.session.user.id, data)
      }),
    )
  })

export const getCurrentRoomFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.currentRoom(context.session.user.id)
      }),
    )
  })

// Rollback compatibility for clients that cannot establish the lobby EventSource. Remove only
// after the live-event transport has been stable for a full release.
export const getWaitingLobbyFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.waitingLobby(context.session.user.id)
      }),
    )
  })

export const getGameHistoryFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return context.gameRuntime.runPromise(
      Effect.map(
        Effect.flatMap(GameService, (games) => {
          return games.history(context.session.user.id)
        }),
        (history) => {
          return { userId: context.session.user.id, history }
        },
      ),
    )
  })

export const joinRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(joinRoomInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinRoom(context.session.user.id, data.code)
      }),
    )
  })

export const leaveRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return pokeAfterCommit(
      data.roomId,
      context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.leaveRoom(context.session.user.id, data.roomId)
        }),
      ),
    )
  })

export const getRoomFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.getRoom(context.session.user.id, data.roomId)
      }),
    )
  })

export const submitCommandFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(submitCommandInput)
  .handler(({ data, context }) => {
    return pokeAfterCommit(
      data.roomId,
      context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return submitCommandResponse(
            data.responseVersion,
            games.submit(context.session.user.id, data),
            () => {
              return games.getRoom(context.session.user.id, data.roomId)
            },
          )
        }),
      ),
    )
  })

export const voteForBotFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(voteForBotInput)
  .handler(({ data, context }) => {
    return pokeAfterCommit(
      data.roomId,
      context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.voteForBot(
            context.session.user.id,
            data.roomId,
            data.disconnectedSeat,
            data.approve,
          )
        }),
      ),
    )
  })

export const confirmRematchFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return pokeAfterCommit(
      data.roomId,
      context.gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.confirmRematch(context.session.user.id, data.roomId)
        }),
      ),
    )
  })
