import type { AuthenticatedBootstrap, AuthenticatedSession } from './authenticated-routes'

export function bootstrapForSession(
  session: AuthenticatedSession,
  bootstrap: AuthenticatedBootstrap,
): AuthenticatedBootstrap | null {
  return session.user.id === bootstrap.session.user.id ? bootstrap : null
}

export function authenticatedProviderKey(bootstrap: AuthenticatedBootstrap): string {
  return bootstrap.session.user.id
}

export function isCurrentRoomStreamEvent(
  effectRoomId: string,
  activeRoomId: string | null,
  eventRoomId: string = effectRoomId,
): boolean {
  return activeRoomId === effectRoomId && eventRoomId === effectRoomId
}

export function isCurrentLobbyStreamEvent(effectEpoch: number, currentEpoch: number): boolean {
  return effectEpoch === currentEpoch
}

export function shouldInvalidateLobbyEpoch(
  currentPartyId: string | null,
  nextPartyId: string | null,
): boolean {
  return currentPartyId !== nextPartyId
}
