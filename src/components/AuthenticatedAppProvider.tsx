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
import { isCurrentRoomStreamEvent } from '../authenticated-app-state'
import {
  createInviteExecutionRegistry,
  type AuthenticatedBootstrap,
  type InviteExecutionRegistry,
} from '../authenticated-routes'
import { acceptRoomUpdate, type PartyView, type RoomView } from '../multiplayer'
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
  const lobbyPollGenerationRef = useRef(0)
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
    if (next === null) {
      lobbyPollGenerationRef.current += 1
    }
    setPartyStateValue(next)
  }, [])

  const leaveRoom = useCallback(
    (leftParty = false) => {
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
  const sessionUserId = bootstrap.session.user.id

  useEffect(() => {
    if (!partyId || roomId) {
      return
    }
    const generation = lobbyPollGenerationRef.current
    const polling = startWaitingLobbyPolling({
      load: () => {
        return getWaitingLobbyFn()
      },
      apply: ({ party: nextParty, room: nextRoom }) => {
        setParty(nextParty)
        if (nextRoom) {
          openRoom(nextRoom)
        }
      },
      isCurrent: () => {
        return lobbyPollGenerationRef.current === generation
      },
      getVisibilityState: () => {
        return document.visibilityState
      },
      addVisibilityListener: (listener) => {
        document.addEventListener('visibilitychange', listener)
        return () => {
          document.removeEventListener('visibilitychange', listener)
        }
      },
      setTimeout: (callback, delayMs) => {
        return globalThis.setTimeout(callback, delayMs)
      },
      clearTimeout: (timer) => {
        globalThis.clearTimeout(timer)
      },
    })
    return () => {
      lobbyPollGenerationRef.current += 1
      polling.stop()
    }
  }, [openRoom, partyId, roomId, setParty, sessionUserId])

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
    let events: EventSource | undefined
    const timer = window.setTimeout(() => {
      const storageKey = 'euchre:event-stream-id'
      const streamId = window.sessionStorage.getItem(storageKey) ?? crypto.randomUUID()
      window.sessionStorage.setItem(storageKey, streamId)
      events = new EventSource(`/api/tables/${roomId}/events?stream=${streamId}`)
      events.addEventListener('room', (event) => {
        const nextRoom = JSON.parse((event as MessageEvent<string>).data) as RoomView
        if (!isCurrentRoomStreamEvent(roomId, activeRoomIdRef.current, nextRoom.id)) {
          return
        }
        setRoom(nextRoom)
      })
      events.addEventListener('gone', () => {
        if (!isCurrentRoomStreamEvent(roomId, activeRoomIdRef.current)) {
          return
        }
        handleRoomGone()
      })
    }, 100)
    return () => {
      window.clearTimeout(timer)
      events?.close()
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
