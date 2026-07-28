import { createFileRoute } from '@tanstack/react-router'
import { createDb } from '../../../db/index.server'
import { createAuth } from '../../../lib/auth.server'

function handleAuth(request: Request) {
  return createAuth(createDb()).handler(request)
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => {
        return handleAuth(request)
      },
      POST: ({ request }) => {
        return handleAuth(request)
      },
    },
  },
})
