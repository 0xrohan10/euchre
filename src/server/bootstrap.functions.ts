import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { Effect } from 'effect'
import { projectAuthenticatedBootstrap, projectAuthenticatedSession } from '../authenticated-routes'
import { createDb } from '../db/index.server'
import { createAuth } from '../lib/auth.server'
import { GameService, createGameRuntime } from './game-service.server'

export const getAuthenticatedSessionFn = createServerFn({ method: 'GET' }).handler(async () => {
  const database = createDb()
  const auth = createAuth(database)
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  return session ? projectAuthenticatedSession(session) : null
})

export const getAuthenticatedBootstrapFn = createServerFn({ method: 'GET' }).handler(async () => {
  const database = createDb()
  const auth = createAuth(database)
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) {
    return null
  }

  const gameRuntime = createGameRuntime(database)
  try {
    const [room, party] = await Promise.all([
      gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.currentRoom(session.user.id)
        }),
      ),
      gameRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.currentParty(session.user.id)
        }),
      ),
    ])
    return projectAuthenticatedBootstrap(session, room, party)
  } finally {
    await gameRuntime.dispose()
  }
})
