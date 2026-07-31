/* oxlint-disable react/only-export-components */
import { useEffect } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { historyForSession } from '../../authenticated-routes'
import { GameHistory } from '../../components/GameHistory'
import { getGameHistoryFn } from '../../server/game.functions'
import '../../App.css'

export const Route = createFileRoute('/_authenticated/history')({
  loader: () => {
    return getGameHistoryFn()
  },
  pendingComponent: HistoryPending,
  errorComponent: HistoryError,
  component: HistoryRoute,
})

function HistoryRoute() {
  const result = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const history = historyForSession(session, result)

  return <HistoryIdentityBoundary history={history} />
}

function HistoryIdentityBoundary({ history }: { history: ReturnType<typeof historyForSession> }) {
  const router = useRouter()

  useEffect(() => {
    if (!history) {
      void router.invalidate()
    }
  }, [history, router])

  return history ? <GameHistory history={history} /> : <HistoryPending />
}

function HistoryPending() {
  return (
    <main className="auth-shell">
      <span className="eyebrow">Loading history...</span>
    </main>
  )
}

function HistoryError() {
  return (
    <main className="history-shell">
      <p className="form-error" role="alert">
        Could not load your game history.
      </p>
    </main>
  )
}
