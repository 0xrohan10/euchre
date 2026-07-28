import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { AuthScreen } from './components/AuthScreen'
import { GameTable } from './components/GameTable'
import { Lobby } from './components/Lobby'
import { authClient } from './lib/auth-client'
import {
  getCurrentPartyFn,
  getCurrentRoomFn,
  getWaitingLobbyFn,
  joinPartyFn,
  joinRoomFn,
} from './server/game.functions'
import { acceptRoomUpdate, type PartyView, type RoomView } from './multiplayer'
import { startWaitingLobbyPolling } from './waiting-lobby-polling'
import './App.css'

export default function App() {
  const { data: session, isPending } = authClient.useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const { code: gameCode } = useParams({ strict: false })
  const [room, setRoom] = useState<RoomView | null>(null)
  const [party, setParty] = useState<PartyView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const roomId = room?.id
  const updateRoom = useCallback(
    (next: RoomView) => {
      setRoom((current) => {
        return acceptRoomUpdate(current, next)
      })
      if (window.location.pathname !== `/games/${next.code}`) {
        void navigate({ to: '/games/$code', params: { code: next.code }, replace: true })
      }
    },
    [navigate],
  )
  const lobbyPollGenerationRef = useRef(0)
  const setPartyState = useCallback((next: PartyView | null) => {
    if (next === null) {
      lobbyPollGenerationRef.current += 1
    }
    setParty(next)
  }, [])
  const leaveRoom = useCallback(
    (leftParty = false) => {
      setRoom(null)
      if (leftParty) {
        setPartyState(null)
      }
      void navigate({ to: '/', replace: true })
    },
    [navigate, setPartyState],
  )

  useEffect(() => {
    if (!session || loaded) {
      return
    }
    const legacyInvite = new URLSearchParams(window.location.search).get('room')
    const partnerInvite = location.pathname.startsWith('/partners/') ? gameCode : undefined
    const tableInvite = location.pathname.startsWith('/games/') ? gameCode : legacyInvite
    const load = async () => {
      if (partnerInvite) {
        try {
          setPartyState(await joinPartyFn({ data: { inviteCode: partnerInvite } }))
        } catch {
          setLoadError('That partner invite is invalid or has already been used.')
        } finally {
          await navigate({ to: '/', replace: true })
        }
      }
      const [roomResult, partyResult] = await Promise.allSettled([
        tableInvite ? joinRoomFn({ data: { code: tableInvite } }) : getCurrentRoomFn(),
        getCurrentPartyFn(),
      ])
      if (roomResult.status === 'fulfilled' && roomResult.value) {
        updateRoom(roomResult.value)
      }
      if (partyResult.status === 'fulfilled') {
        setPartyState(partyResult.value)
      }
      if (roomResult.status === 'rejected') {
        setLoadError(
          tableInvite ? 'Could not join that table.' : 'Could not load your current game.',
        )
      } else if (partyResult.status === 'rejected') {
        setLoadError('Could not load your partnership.')
      }
    }
    void load().finally(() => {
      return setLoaded(true)
    })
  }, [gameCode, loaded, location.pathname, navigate, session, setPartyState, updateRoom])

  const partyId = party?.id
  const sessionUserId = session?.user.id

  useEffect(() => {
    if (!partyId || !sessionUserId || room) {
      return
    }
    const generation = lobbyPollGenerationRef.current
    const polling = startWaitingLobbyPolling({
      load: () => {
        return getWaitingLobbyFn()
      },
      apply: ({ party: nextParty, room: nextRoom }) => {
        if (nextParty === null) {
          setPartyState(null)
        } else {
          setParty(nextParty)
        }
        if (nextRoom) {
          updateRoom(nextRoom)
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
  }, [partyId, room, sessionUserId, setPartyState, updateRoom])

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
        const next = JSON.parse((event as MessageEvent<string>).data) as RoomView
        setRoom((current) => {
          return acceptRoomUpdate(current, next)
        })
      })
      events.addEventListener('gone', () => {
        setRoom(null)
        void getCurrentPartyFn().then(setPartyState)
        void navigate({ to: '/', replace: true })
      })
    }, 100)
    return () => {
      window.clearTimeout(timer)
      events?.close()
    }
  }, [navigate, roomId, setPartyState])

  if (isPending) {
    return (
      <main className="auth-shell">
        <span className="eyebrow">Loading table…</span>
      </main>
    )
  }

  if (!session) {
    return <AuthScreen />
  }

  if (!loaded) {
    return (
      <main className="auth-shell">
        <span className="eyebrow">Finding your seat…</span>
      </main>
    )
  }

  if (!room || room.status === 'lobby' || !room.game) {
    return (
      <Lobby
        room={room}
        party={party}
        initialError={loadError}
        onRoom={updateRoom}
        onParty={setPartyState}
        onLeave={leaveRoom}
        userId={session.user.id}
        userName={session.user.name}
      />
    )
  }

  return <GameTable room={room} onRoom={updateRoom} onLeave={leaveRoom} />
}
