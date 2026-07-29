import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { authMiddleware } from '../lib/auth.middleware'
import {
  joinPartyInput,
  joinRoomInput,
  roomIdInput,
  rulesInput,
  submitCommandInput,
  voteForBotInput,
} from '../lib/game.validation'
import { GameService } from './game-service.server'

export const createRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createRoom(context.session.user.id, data)
      }),
    )
  })

export const createSinglePlayerRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createSinglePlayerRoom(context.session.user.id, data)
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
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.leaveRoom(context.session.user.id, data.roomId)
      }),
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
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.submit(context.session.user.id, data)
      }),
    )
  })

export const voteForBotFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(voteForBotInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.voteForBot(
          context.session.user.id,
          data.roomId,
          data.disconnectedSeat,
          data.approve,
        )
      }),
    )
  })

export const confirmRematchFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return context.gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.confirmRematch(context.session.user.id, data.roomId)
      }),
    )
  })
