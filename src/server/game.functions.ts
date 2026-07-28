import { createServerFn } from '@tanstack/react-start'
import { Effect } from 'effect'
import { SUITS, type GameAction, type GameRules } from '../game'
import type { PlayerAction } from '../multiplayer'
import { authMiddleware } from '../lib/auth.middleware'
import { GameService, gameRuntime } from './game-service.server'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid request.')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}.`)
  }
  return value
}

const roomIdInput = (value: unknown) => {
  return { roomId: text(object(value).roomId, 'room ID') }
}

function rulesInput(value: unknown): GameRules {
  const rules = object(object(value).rules)
  if (
    typeof rules.stickDealer !== 'boolean' ||
    typeof rules.requireNaturalTrump !== 'boolean' ||
    typeof rules.allowAloneWhenOrderingPartner !== 'boolean' ||
    typeof rules.allowFarmersHand !== 'boolean'
  ) {
    throw new Error('Invalid game rules.')
  }
  return {
    stickDealer: rules.stickDealer,
    requireNaturalTrump: rules.requireNaturalTrump,
    allowAloneWhenOrderingPartner: rules.allowAloneWhenOrderingPartner,
    allowFarmersHand: rules.allowFarmersHand,
  }
}

function action(value: unknown): PlayerAction | { type: 'next-hand' } | { type: 'new-match' } {
  const input = object(value)
  switch (input.type) {
    case 'pass':
    case 'exchange-kitty':
    case 'decline-exchange':
    case 'next-hand':
    case 'new-match':
      return { type: input.type }
    case 'order-up':
      if (typeof input.alone !== 'boolean') {
        throw new Error('Invalid action.')
      }
      return { type: 'order-up', alone: input.alone }
    case 'call-trump':
      if (typeof input.alone !== 'boolean' || !SUITS.includes(input.suit as never)) {
        throw new Error('Invalid action.')
      }
      return {
        type: 'call-trump',
        suit: input.suit as Extract<GameAction, { type: 'call-trump' }>['suit'],
        alone: input.alone,
      }
    case 'discard':
    case 'play':
      return { type: input.type, cardId: text(input.cardId, 'card') }
    default:
      throw new Error('Invalid action.')
  }
}

export const createRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createRoom(context.session.user.id, data)
      }),
    )
  })

export const createSinglePlayerRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createSinglePlayerRoom(context.session.user.id, data)
      }),
    )
  })

export const getCurrentPartyFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.currentParty(context.session.user.id)
      }),
    )
  })

export const createPartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.createParty(context.session.user.id)
      }),
    )
  })

export const joinPartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((value: unknown) => {
    return { inviteCode: text(object(value).inviteCode, 'partner invite') }
  })
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinParty(context.session.user.id, data.inviteCode)
      }),
    )
  })

export const leavePartyFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.leaveParty(context.session.user.id)
      }),
    )
  })

export const startPartyRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(rulesInput)
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.startPartyRoom(context.session.user.id, data)
      }),
    )
  })

export const getCurrentRoomFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.currentRoom(context.session.user.id)
      }),
    )
  })

export const joinRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((value: unknown) => {
    return { code: text(object(value).code, 'invite code').toUpperCase() }
  })
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinRoom(context.session.user.id, data.code)
      }),
    )
  })

export const leaveRoomFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.leaveRoom(context.session.user.id, data.roomId)
      }),
    )
  })

export const getRoomFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator(roomIdInput)
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.getRoom(context.session.user.id, data.roomId)
      }),
    )
  })

export const submitCommandFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((value: unknown) => {
    const input = object(value)
    const expectedVersion = input.expectedVersion
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 0) {
      throw new Error('Invalid game version.')
    }
    return {
      roomId: text(input.roomId, 'room ID'),
      commandId: text(input.commandId, 'command ID'),
      expectedVersion: expectedVersion as number,
      action: action(input.action),
    }
  })
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.submit(context.session.user.id, data)
      }),
    )
  })

export const voteForBotFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((value: unknown) => {
    const input = object(value)
    if (typeof input.approve !== 'boolean') {
      throw new Error('Invalid vote.')
    }
    if (
      !Number.isInteger(input.disconnectedSeat) ||
      (input.disconnectedSeat as number) < 0 ||
      (input.disconnectedSeat as number) > 3
    ) {
      throw new Error('Invalid disconnected seat.')
    }
    return {
      roomId: text(input.roomId, 'room ID'),
      disconnectedSeat: input.disconnectedSeat as 0 | 1 | 2 | 3,
      approve: input.approve,
    }
  })
  .handler(({ data, context }) => {
    return gameRuntime.runPromise(
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
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.confirmRematch(context.session.user.id, data.roomId)
      }),
    )
  })
