/* oxlint-disable react/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import {
  isCurrentLobbyStreamEvent,
  isCurrentRoomStreamEvent,
  shouldInvalidateLobbyEpoch,
} from '../authenticated-app-state'
import {
  createInviteExecutionRegistry,
  type AuthenticatedBootstrap,
  type InviteExecutionRegistry,
} from '../authenticated-routes'
import { acceptRoomUpdate, type PartyView, type RoomView } from '../multiplayer'
import { getPageConnectionIdentity, startLiveEventSource } from '../live-event-source'
import {
  RequestDeadlineError,
  STALE_CONNECTION,
  type LiveConnectionState,
  withRequestDeadline,
} from '../interaction-feedback'
import { authClient } from '../lib/auth-client'
import { startLobbyLiveTransport } from '../lobby-live-transport'
import { getCurrentPartyFn, getWaitingLobbyFn } from '../server/game.functions'
import { startWaitingLobbyPolling } from '../waiting-lobby-polling'

type AuthenticatedAppState = {
  session: AuthenticatedBootstrap['session']
  room: RoomView | null
  party: PartyView | null
  roomConnection: LiveConnectionState
  loadError: string
  setLoadError: (error: string) => void
  setRoom: (room: RoomView) => void
  openRoom: (room: RoomView) => void | Promise<void>
  setParty: (party: PartyView | null) => void
  leaveRoom: (leftParty?: boolean) => void
  signOut: () => void
  runInvite: InviteExecutionRegistry['run']
}

type SignOutState = 'idle' | 'pending' | 'ambiguous' | 'failed'
type SignOutAttemptState = Exclude<SignOutState, 'idle'>
type SignOutOperation = {
  generation: number
  nextAttempt: number
  completed: boolean
  attempts: Map<number, SignOutAttemptState>
}

const AuthenticatedAppContext = createContext<AuthenticatedAppState | null>(null)

export function AuthenticatedAppProvider({
  bootstrap,
  children,
}: {
  bootstrap: AuthenticatedBootstrap
  children: ReactNode
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const location = useLocation()
  const [room, setRoomState] = useState(bootstrap.room)
  const [party, setPartyStateValue] = useState(bootstrap.party)
  const [loadError, setLoadError] = useState('')
  const [roomConnection, setRoomConnection] = useState<LiveConnectionState>(STALE_CONNECTION)
  const [signOutState, setSignOutState] = useState<SignOutState>('idle')
  const lobbyEpochRef = useRef(0)
  const partyIdRef = useRef(bootstrap.party?.id ?? null)
  const roomTransitionGenerationRef = useRef(0)
  const inviteRegistryRef = useRef<InviteExecutionRegistry | null>(null)
  const activeRoomIdRef = useRef<string | null>(bootstrap.room?.id ?? null)
  const lobbyTransportRef = useRef<ReturnType<typeof startLobbyLiveTransport> | null>(null)
  const roomTransportRef = useRef<ReturnType<typeof startLiveEventSource> | null>(null)
  const authenticatedGenerationRef = useRef(0)
  const signOutGenerationRef = useRef(0)
  const signOutOperationRef = useRef<SignOutOperation | null>(null)
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  if (inviteRegistryRef.current === null) {
    inviteRegistryRef.current = createInviteExecutionRegistry()
  }
  const authenticatedGeneration = authenticatedGenerationRef.current

  const setAuthenticatedLoadError = useCallback(
    (error: string) => {
      if (authenticatedGenerationRef.current === authenticatedGeneration) {
        setLoadError(error)
      }
    },
    [authenticatedGeneration],
  )

  const setRoom = useCallback(
    (next: RoomView) => {
      if (
        authenticatedGenerationRef.current !== authenticatedGeneration ||
        activeRoomIdRef.current !== next.id
      ) {
        return
      }
      setRoomState((current) => {
        return acceptRoomUpdate(current, next)
      })
    },
    [authenticatedGeneration],
  )

  const openRoom = useCallback(
    async (next: RoomView) => {
      if (authenticatedGenerationRef.current !== authenticatedGeneration) {
        return
      }
      lobbyEpochRef.current += 1
      const generation = roomTransitionGenerationRef.current + 1
      roomTransitionGenerationRef.current = generation
      activeRoomIdRef.current = next.id
      setRoomState((current) => {
        return current?.id === next.id ? acceptRoomUpdate(current, next) : next
      })

      if (pathnameRef.current !== `/games/${next.code}`) {
        try {
          await withRequestDeadline(() => {
            return navigate({ to: '/games/$code', params: { code: next.code }, replace: true })
          })
        } catch {
          if (
            authenticatedGenerationRef.current !== authenticatedGeneration ||
            roomTransitionGenerationRef.current !== generation
          ) {
            return
          }
          try {
            router.history.replace(`/games/${next.code}`)
          } catch {
            window.location.replace(`/games/${next.code}`)
          }
        }
      }
    },
    [authenticatedGeneration, navigate, router],
  )

  const setParty = useCallback(
    (next: PartyView | null) => {
      if (authenticatedGenerationRef.current !== authenticatedGeneration) {
        return
      }
      const nextPartyId = next?.id ?? null
      if (shouldInvalidateLobbyEpoch(partyIdRef.current, nextPartyId)) {
        lobbyEpochRef.current += 1
      }
      partyIdRef.current = nextPartyId
      setPartyStateValue(next)
    },
    [authenticatedGeneration],
  )

  const leaveRoom = useCallback(
    (leftParty = false) => {
      if (authenticatedGenerationRef.current !== authenticatedGeneration) {
        return
      }
      lobbyEpochRef.current += 1
      roomTransitionGenerationRef.current += 1
      activeRoomIdRef.current = null
      setRoomState(null)
      if (leftParty) {
        setParty(null)
      }
      void navigate({ to: '/', replace: true })
    },
    [authenticatedGeneration, navigate, setParty],
  )

  const clearAuthenticatedState = useCallback(() => {
    authenticatedGenerationRef.current += 1
    lobbyEpochRef.current += 1
    roomTransitionGenerationRef.current += 1
    activeRoomIdRef.current = null
    partyIdRef.current = null
    lobbyTransportRef.current?.stop()
    lobbyTransportRef.current = null
    roomTransportRef.current?.stop()
    roomTransportRef.current = null
    inviteRegistryRef.current = createInviteExecutionRegistry()
    setRoomState(null)
    setPartyStateValue(null)
    setRoomConnection(STALE_CONNECTION)
    setLoadError('')
  }, [])

  const updateSignOutState = useCallback((operation: SignOutOperation) => {
    if (
      signOutOperationRef.current !== operation ||
      signOutGenerationRef.current !== operation.generation ||
      operation.completed
    ) {
      return
    }
    const attempts = [...operation.attempts.values()]
    setSignOutState(
      attempts.includes('pending')
        ? 'pending'
        : attempts.includes('ambiguous')
          ? 'ambiguous'
          : 'failed',
    )
  }, [])

  const signOut = useCallback(() => {
    let operation = signOutOperationRef.current
    if (operation?.completed || signOutState === 'pending') {
      return
    }
    if (!operation) {
      const generation = signOutGenerationRef.current + 1
      signOutGenerationRef.current = generation
      operation = {
        generation,
        nextAttempt: 0,
        completed: false,
        attempts: new Map(),
      }
      signOutOperationRef.current = operation
      clearAuthenticatedState()
    }
    const attempt = operation.nextAttempt
    operation.nextAttempt += 1
    operation.attempts.set(attempt, 'pending')
    setSignOutState('pending')

    let revocation: Promise<{ error?: unknown }>
    try {
      revocation = Promise.resolve(authClient.signOut())
    } catch (cause) {
      revocation = Promise.reject(cause)
    }

    void revocation.then(
      async (result) => {
        if (
          signOutOperationRef.current !== operation ||
          signOutGenerationRef.current !== operation.generation ||
          operation.completed
        ) {
          return
        }
        if (result.error) {
          operation.attempts.set(attempt, 'failed')
          updateSignOutState(operation)
          return
        }
        operation.completed = true
        try {
          await withRequestDeadline(() => {
            return router.invalidate()
          })
          await withRequestDeadline(() => {
            return navigate({ to: '/sign-in', replace: true })
          })
        } catch {
          window.location.replace('/sign-in')
        }
      },
      () => {
        if (signOutOperationRef.current === operation && !operation.completed) {
          operation.attempts.set(attempt, 'failed')
          updateSignOutState(operation)
        }
      },
    )
    void withRequestDeadline(() => {
      return revocation
    }).catch((cause: unknown) => {
      if (signOutOperationRef.current !== operation || operation.completed) {
        return
      }
      if (cause instanceof RequestDeadlineError) {
        if (operation.attempts.get(attempt) === 'pending') {
          operation.attempts.set(attempt, 'ambiguous')
          updateSignOutState(operation)
        }
      } else if (operation.attempts.get(attempt) === 'pending') {
        operation.attempts.set(attempt, 'failed')
        updateSignOutState(operation)
      }
    })
  }, [clearAuthenticatedState, navigate, router, signOutState, updateSignOutState])

  const roomId = room?.id
  const partyId = party?.id
  useEffect(() => {
    if (signOutState !== 'idle' || !partyId || roomId) {
      return
    }
    const epoch = lobbyEpochRef.current
    const applySnapshot = ({
      party: nextParty,
      room: nextRoom,
    }: {
      party: PartyView | null
      room: RoomView | null
    }) => {
      if (!isCurrentLobbyStreamEvent(epoch, lobbyEpochRef.current)) {
        return
      }
      setPartyStateValue(nextParty)
      partyIdRef.current = nextParty?.id ?? null
      if (nextRoom) {
        void openRoom(nextRoom)
      }
    }
    const transport = startLobbyLiveTransport({
      getVisibilityState: () => {
        return document.visibilityState
      },
      addVisibilityListener: (listener) => {
        document.addEventListener('visibilitychange', listener)
        return () => {
          document.removeEventListener('visibilitychange', listener)
        }
      },
      startEvents: (onFallback) => {
        return startLiveEventSource<{ party: PartyView | null; room: RoomView | null }>({
          url: `/api/lobby/events?page=${encodeURIComponent(getPageConnectionIdentity())}`,
          scope: 'lobby',
          onSnapshot: applySnapshot,
          onFallback,
        })
      },
      startPolling: () => {
        return startWaitingLobbyPolling({
          load: getWaitingLobbyFn,
          apply: applySnapshot,
          isCurrent: () => {
            return isCurrentLobbyStreamEvent(epoch, lobbyEpochRef.current)
          },
          getVisibilityState: () => {
            return document.visibilityState
          },
          addVisibilityListener: () => {
            return () => {}
          },
          setTimeout: globalThis.setTimeout,
          clearTimeout: globalThis.clearTimeout,
        })
      },
    })
    lobbyTransportRef.current = transport
    return () => {
      if (isCurrentLobbyStreamEvent(epoch, lobbyEpochRef.current)) {
        lobbyEpochRef.current += 1
      }
      transport.stop()
      if (lobbyTransportRef.current === transport) {
        lobbyTransportRef.current = null
      }
    }
  }, [openRoom, partyId, roomId, signOutState])

  const handleRoomGone = useEffectEvent(() => {
    if (signOutState !== 'idle') {
      return
    }
    roomTransitionGenerationRef.current += 1
    activeRoomIdRef.current = null
    setRoomState(null)
    void getCurrentPartyFn().then(setParty)
    if (location.pathname.startsWith('/games/')) {
      void navigate({ to: '/', replace: true })
    }
  })

  useEffect(() => {
    if (signOutState !== 'idle' || !roomId) {
      setRoomConnection(STALE_CONNECTION)
      return
    }
    const events = startLiveEventSource<RoomView>({
      url: `/api/tables/${encodeURIComponent(roomId)}/events?page=${encodeURIComponent(getPageConnectionIdentity())}`,
      scope: 'room',
      onSnapshot: (nextRoom) => {
        if (!isCurrentRoomStreamEvent(roomId, activeRoomIdRef.current, nextRoom.id)) {
          return
        }
        setRoom(nextRoom)
      },
      onConnectionChange: setRoomConnection,
      onTerminal: ({ code }) => {
        if (code !== 'not-found' && code !== 'forbidden') {
          return
        }
        if (!isCurrentRoomStreamEvent(roomId, activeRoomIdRef.current)) {
          return
        }
        handleRoomGone()
      },
    })
    roomTransportRef.current = events
    return () => {
      events.stop()
      if (roomTransportRef.current === events) {
        roomTransportRef.current = null
      }
    }
  }, [roomId, setRoom, signOutState])

  if (signOutState !== 'idle') {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-busy={signOutState === 'pending'}>
          <span className="eyebrow">
            {signOutState === 'pending'
              ? 'Signing out...'
              : signOutState === 'ambiguous'
                ? 'Sign-out status unknown'
                : 'Sign-out interrupted'}
          </span>
          {signOutState === 'ambiguous' && (
            <>
              <p className="form-error" role="alert">
                The sign-out response was lost. Your private game data remains cleared, and the
                original request is still being checked.
              </p>
              <button className="primary-button" type="button" onClick={signOut}>
                Retry sign out safely
              </button>
            </>
          )}
          {signOutState === 'failed' && (
            <>
              <p className="form-error" role="alert">
                Could not sign out. Your private game data remains cleared.
              </p>
              <button className="primary-button" type="button" onClick={signOut}>
                Retry sign out
              </button>
            </>
          )}
        </section>
      </main>
    )
  }

  return (
    <AuthenticatedAppContext
      value={{
        session: bootstrap.session,
        room,
        party,
        roomConnection,
        loadError,
        setLoadError: setAuthenticatedLoadError,
        setRoom,
        openRoom,
        setParty,
        leaveRoom,
        signOut,
        runInvite: inviteRegistryRef.current.run,
      }}
    >
      {children}
    </AuthenticatedAppContext>
  )
}

export function useAuthenticatedApp() {
  const context = useContext(AuthenticatedAppContext)
  if (!context) {
    throw new Error('useAuthenticatedApp must be used inside AuthenticatedAppProvider')
  }
  return context
}
