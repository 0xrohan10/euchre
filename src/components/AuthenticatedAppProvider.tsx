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
import { useLocation, useNavigate } from '@tanstack/react-router'
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
import { startLobbyLiveTransport } from '../lobby-live-transport'
import { getCurrentPartyFn, getWaitingLobbyFn } from '../server/game.functions'
import { startWaitingLobbyPolling } from '../waiting-lobby-polling'

type AuthenticatedAppState = {
  session: AuthenticatedBootstrap['session']
  room: RoomView | null
  party: PartyView | null
  loadError: string
  setLoadError: (error: string) => void
  setRoom: (room: RoomView) => void
  openRoom: (room: RoomView) => void | Promise<void>
  setParty: (party: PartyView | null) => void
  leaveRoom: (leftParty?: boolean) => void
  runInvite: InviteExecutionRegistry['run']
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
  const location = useLocation()
  const [room, setRoomState] = useState(bootstrap.room)
  const [party, setPartyStateValue] = useState(bootstrap.party)
  const [loadError, setLoadError] = useState('')
  const lobbyEpochRef = useRef(0)
  const partyIdRef = useRef(bootstrap.party?.id ?? null)
  const roomTransitionGenerationRef = useRef(0)
  const inviteRegistryRef = useRef<InviteExecutionRegistry | null>(null)
  const activeRoomIdRef = useRef<string | null>(bootstrap.room?.id ?? null)
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  if (inviteRegistryRef.current === null) {
    inviteRegistryRef.current = createInviteExecutionRegistry()
  }

  const setRoom = useCallback((next: RoomView) => {
    if (activeRoomIdRef.current !== next.id) {
      return
    }
    setRoomState((current) => {
      return acceptRoomUpdate(current, next)
    })
  }, [])

  const openRoom = useCallback(
    async (next: RoomView) => {
      lobbyEpochRef.current += 1
      if (activeRoomIdRef.current === next.id) {
        setRoom(next)
        return
      }

      const generation = roomTransitionGenerationRef.current + 1
      roomTransitionGenerationRef.current = generation
      activeRoomIdRef.current = null
      setRoomState(null)

      if (pathnameRef.current !== `/games/${next.code}`) {
        await navigate({ to: '/games/$code', params: { code: next.code }, replace: true })
      }
      if (roomTransitionGenerationRef.current !== generation) {
        return
      }

      activeRoomIdRef.current = next.id
      setRoomState(next)
    },
    [navigate, setRoom],
  )

  const setParty = useCallback((next: PartyView | null) => {
    const nextPartyId = next?.id ?? null
    if (shouldInvalidateLobbyEpoch(partyIdRef.current, nextPartyId)) {
      lobbyEpochRef.current += 1
    }
    partyIdRef.current = nextPartyId
    setPartyStateValue(next)
  }, [])

  const leaveRoom = useCallback(
    (leftParty = false) => {
      lobbyEpochRef.current += 1
      roomTransitionGenerationRef.current += 1
      activeRoomIdRef.current = null
      setRoomState(null)
      if (leftParty) {
        setParty(null)
      }
      void navigate({ to: '/', replace: true })
    },
    [navigate, setParty],
  )

  const roomId = room?.id
  const partyId = party?.id
  useEffect(() => {
    if (!partyId || roomId) {
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
    return () => {
      if (isCurrentLobbyStreamEvent(epoch, lobbyEpochRef.current)) {
        lobbyEpochRef.current += 1
      }
      transport.stop()
    }
  }, [openRoom, partyId, roomId])

  const handleRoomGone = useEffectEvent(() => {
    roomTransitionGenerationRef.current += 1
    activeRoomIdRef.current = null
    setRoomState(null)
    void getCurrentPartyFn().then(setParty)
    if (location.pathname.startsWith('/games/')) {
      void navigate({ to: '/', replace: true })
    }
  })

  useEffect(() => {
    if (!roomId) {
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
    return () => {
      events.stop()
    }
  }, [roomId, setRoom])

  return (
    <AuthenticatedAppContext
      value={{
        session: bootstrap.session,
        room,
        party,
        loadError,
        setLoadError,
        setRoom,
        openRoom,
        setParty,
        leaveRoom,
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
