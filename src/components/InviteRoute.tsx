import { useEffect } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import App from '../App'
import { withRequestDeadline } from '../interaction-feedback'
import {
  getCurrentPartyFn,
  getCurrentRoomFn,
  joinPartyFn,
  joinRoomFn,
} from '../server/game.functions'
import { useAuthenticatedApp } from './AuthenticatedAppProvider'

function useNavigationKey(kind: 'party' | 'room', code: string) {
  const location = useLocation()
  return `${location.state.__TSR_key ?? location.href}:${kind}:${code}`
}

function observeInviteSettlement<T>(
  join: Promise<T>,
  applySuccess: (value: T) => void | Promise<void>,
) {
  let generation = 0
  let success: Promise<void> | null = null

  void join.then(
    (value) => {
      if (success) {
        return
      }
      generation += 1
      success = Promise.resolve().then(() => {
        return applySuccess(value)
      })
      void success.catch(() => {})
    },
    () => {},
  )

  return {
    async waitForSuccess() {
      await Promise.resolve()
      if (success) {
        await success
        return true
      }
      return false
    },
    beginFailure() {
      return generation
    },
    async mayApplyFailure(failureGeneration: number) {
      await Promise.resolve()
      return success === null && generation === failureGeneration
    },
  }
}

function startInviteJoin<T>(join: () => Promise<T>) {
  try {
    return Promise.resolve(join())
  } catch (cause) {
    return Promise.reject(cause)
  }
}

export function RoomInviteRoute({ code }: { code: string }) {
  const navigationKey = useNavigationKey('room', code)
  const navigate = useNavigate()
  const { runInvite, openRoom, setParty, setLoadError } = useAuthenticatedApp()

  useEffect(() => {
    void runInvite(navigationKey, async () => {
      const join = startInviteJoin(() => {
        return joinRoomFn({ data: { code } })
      })
      const settlement = observeInviteSettlement(join, openRoom)
      try {
        await withRequestDeadline(() => {
          return join
        })
        await settlement.waitForSuccess()
      } catch {
        const [currentRoom, currentParty] = await Promise.all([
          withRequestDeadline(getCurrentRoomFn).catch(() => {
            return null
          }),
          withRequestDeadline(getCurrentPartyFn).catch(() => {
            return null
          }),
        ])
        if (await settlement.waitForSuccess()) {
          return
        }
        const failureGeneration = settlement.beginFailure()
        setParty(currentParty)
        if (!(await settlement.mayApplyFailure(failureGeneration))) {
          return
        }
        if (currentRoom) {
          await openRoom(currentRoom)
          return
        }
        setLoadError('Could not join that table. Please try again.')
        if (!(await settlement.mayApplyFailure(failureGeneration))) {
          return
        }
        try {
          await withRequestDeadline(() => {
            return navigate({ to: '/', replace: true })
          })
        } catch {
          window.location.replace('/')
        }
        throw new Error('Room invite join was not confirmed.')
      }
    }).catch(() => {})
  }, [code, navigate, navigationKey, openRoom, runInvite, setLoadError, setParty])

  return <App />
}

export function PartyInviteRoute({ code }: { code: string }) {
  const navigationKey = useNavigationKey('party', code)
  const navigate = useNavigate()
  const { runInvite, openRoom, setParty, setLoadError } = useAuthenticatedApp()

  useEffect(() => {
    void runInvite(navigationKey, async () => {
      const join = startInviteJoin(() => {
        return joinPartyFn({ data: { inviteCode: code } })
      })
      const settlement = observeInviteSettlement(join, async (party) => {
        setParty(party)
        try {
          await withRequestDeadline(() => {
            return navigate({ to: '/', replace: true })
          })
        } catch {
          window.location.replace('/')
        }
      })
      try {
        await withRequestDeadline(() => {
          return join
        })
        await settlement.waitForSuccess()
      } catch {
        const [currentRoom, currentParty] = await Promise.all([
          withRequestDeadline(getCurrentRoomFn).catch(() => {
            return null
          }),
          withRequestDeadline(getCurrentPartyFn).catch(() => {
            return null
          }),
        ])
        if (await settlement.waitForSuccess()) {
          return
        }
        const failureGeneration = settlement.beginFailure()
        if (currentRoom) {
          await openRoom(currentRoom)
          return
        }
        if (currentParty) {
          setParty(currentParty)
        } else {
          setLoadError('Could not join that partnership. Check the invite and try again.')
        }
        if (!(await settlement.mayApplyFailure(failureGeneration))) {
          return
        }
        try {
          await withRequestDeadline(() => {
            return navigate({ to: '/', replace: true })
          })
        } catch {
          window.location.replace('/')
        }
        if (!currentParty) {
          throw new Error('Party invite join was not confirmed.')
        }
      }
    }).catch(() => {})
  }, [code, navigate, navigationKey, openRoom, runInvite, setLoadError, setParty])

  return (
    <main className="auth-shell">
      <span className="eyebrow">Joining partnership...</span>
    </main>
  )
}
