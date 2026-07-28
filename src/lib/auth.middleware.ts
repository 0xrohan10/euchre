import { createMiddleware } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { createDb } from '../db/index.server'
import { createGameRuntime } from '../server/game-service.server'
import { createAuth } from './auth.server'

export const authMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const database = createDb()
  const auth = createAuth(database)
  const session = await auth.api.getSession({ headers: getRequestHeaders() })
  if (!session) {
    throw new Response('Unauthorized', { status: 401 })
  }
  const gameRuntime = createGameRuntime(database)
  try {
    return await next({ context: { gameRuntime, session } })
  } finally {
    await gameRuntime.dispose()
  }
})
