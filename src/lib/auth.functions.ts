import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { createDb } from '../db/index.server'
import { createAuth } from './auth.server'

export const getSession = createServerFn({ method: 'GET' }).handler(async () => {
  const auth = createAuth(createDb())
  return auth.api.getSession({
    headers: getRequestHeaders(),
  })
})
