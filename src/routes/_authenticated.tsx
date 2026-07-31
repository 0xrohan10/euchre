/* oxlint-disable react/only-export-components */
import { useEffect, type ReactNode } from 'react'
import { Outlet, createFileRoute, useRouter } from '@tanstack/react-router'
import { authenticatedProviderKey, bootstrapForSession } from '../authenticated-app-state'
import { requireAuthenticatedBootstrap, requireAuthenticatedSession } from '../authenticated-routes'
import { AuthenticatedAppProvider } from '../components/AuthenticatedAppProvider'
import {
  getAuthenticatedBootstrapFn,
  getAuthenticatedSessionFn,
} from '../server/bootstrap.functions'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location }) => {
    return {
      session: requireAuthenticatedSession(await getAuthenticatedSessionFn(), location.href),
    }
  },
  loader: async ({ location }) => {
    return requireAuthenticatedBootstrap(await getAuthenticatedBootstrapFn(), location.href)
  },
  staleTime: Number.POSITIVE_INFINITY,
  pendingComponent: AuthenticatedPending,
  errorComponent: AuthenticatedError,
  component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
  const bootstrap = Route.useLoaderData()
  const { session } = Route.useRouteContext()
  const currentBootstrap = bootstrapForSession(session, bootstrap)

  return (
    <AuthenticatedIdentityBoundary isCurrent={currentBootstrap !== null}>
      {currentBootstrap ? (
        <AuthenticatedAppProvider
          key={authenticatedProviderKey(currentBootstrap)}
          bootstrap={currentBootstrap}
        >
          <Outlet />
        </AuthenticatedAppProvider>
      ) : null}
    </AuthenticatedIdentityBoundary>
  )
}

function AuthenticatedIdentityBoundary({
  isCurrent,
  children,
}: {
  isCurrent: boolean
  children: ReactNode
}) {
  const router = useRouter()

  useEffect(() => {
    if (!isCurrent) {
      void router.invalidate()
    }
  }, [isCurrent, router])

  if (!isCurrent) {
    return <AuthenticatedPending />
  }

  return <>{children}</>
}

function AuthenticatedPending() {
  return (
    <main className="auth-shell">
      <span className="eyebrow">Finding your seat...</span>
    </main>
  )
}

function AuthenticatedError() {
  return (
    <main className="auth-shell">
      <p className="form-error" role="alert">
        Could not load your table. Please try again.
      </p>
    </main>
  )
}
