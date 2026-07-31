import { redirect } from '@tanstack/react-router'
import type { GameHistorySummary } from './game/history'
import type { PartyView, RoomView } from './multiplayer'

export type AuthenticatedSession = {
  user: {
    id: string
    name: string
  }
}

export type AuthenticatedBootstrap = {
  session: AuthenticatedSession
  room: RoomView | null
  party: PartyView | null
}

export type AuthenticatedHistory = {
  userId: string
  history: GameHistorySummary[]
}

export function projectAuthenticatedSession(session: {
  user: { id: string; name: string }
}): AuthenticatedSession {
  return { user: { id: session.user.id, name: session.user.name } }
}

export function projectAuthenticatedBootstrap(
  session: { user: { id: string; name: string } },
  room: RoomView | null,
  party: PartyView | null,
): AuthenticatedBootstrap {
  return {
    session: projectAuthenticatedSession(session),
    room,
    party,
  }
}

export function requireAuthenticatedSession(
  session: AuthenticatedSession | null,
  returnTo: string,
): AuthenticatedSession {
  if (!session) {
    throw redirect({ to: '/sign-in', search: { returnTo } })
  }
  return session
}

export function requireAuthenticatedBootstrap(
  bootstrap: AuthenticatedBootstrap | null,
  returnTo: string,
): AuthenticatedBootstrap {
  if (!bootstrap) {
    throw redirect({ to: '/sign-in', search: { returnTo } })
  }
  return bootstrap
}

export function historyForSession(
  session: AuthenticatedSession,
  result: AuthenticatedHistory,
): GameHistorySummary[] | null {
  return result.userId === session.user.id ? result.history : null
}

export function safeReturnTo(returnTo: string | undefined, origin: string): string {
  if (!returnTo) {
    return '/'
  }
  try {
    const target = new URL(returnTo, origin)
    if (target.origin !== origin) {
      return '/'
    }
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return '/'
  }
}

export type InviteExecutionRegistry = {
  run: <T>(navigationKey: string, operation: () => Promise<T>) => Promise<T | undefined>
}

export function createInviteExecutionRegistry(): InviteExecutionRegistry {
  const executed = new Set<string>()
  return {
    async run(navigationKey, operation) {
      if (executed.has(navigationKey)) {
        return undefined
      }
      executed.add(navigationKey)
      try {
        return await operation()
      } catch (cause) {
        executed.delete(navigationKey)
        throw cause
      }
    },
  }
}
