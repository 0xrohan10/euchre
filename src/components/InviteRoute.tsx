import { useEffect } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import App from '../App'
import { joinPartyFn, joinRoomFn } from '../server/game.functions'
import { useAuthenticatedApp } from './AuthenticatedAppProvider'

function useNavigationKey(kind: 'party' | 'room', code: string) {
  const location = useLocation()
  return `${location.state.__TSR_key ?? location.href}:${kind}:${code}`
}

export function RoomInviteRoute({ code }: { code: string }) {
  const navigationKey = useNavigationKey('room', code)
  const navigate = useNavigate()
  const { runInvite, openRoom, setLoadError } = useAuthenticatedApp()

  useEffect(() => {
    void runInvite(navigationKey, async () => {
      try {
        openRoom(await joinRoomFn({ data: { code } }))
      } catch {
        setLoadError('Could not join that table.')
        await navigate({ to: '/', replace: true })
      }
    })
  }, [code, navigate, navigationKey, openRoom, runInvite, setLoadError])

  return <App />
}

export function PartyInviteRoute({ code }: { code: string }) {
  const navigationKey = useNavigationKey('party', code)
  const navigate = useNavigate()
  const { runInvite, setParty, setLoadError } = useAuthenticatedApp()

  useEffect(() => {
    void runInvite(navigationKey, async () => {
      try {
        setParty(await joinPartyFn({ data: { inviteCode: code } }))
      } catch {
        setLoadError('That partner invite is invalid or has already been used.')
      } finally {
        await navigate({ to: '/', replace: true })
      }
    })
  }, [code, navigate, navigationKey, runInvite, setLoadError, setParty])

  return (
    <main className="auth-shell">
      <span className="eyebrow">Joining partnership...</span>
    </main>
  )
}
