/* oxlint-disable react/only-export-components */
import { createFileRoute } from '@tanstack/react-router'
import { AuthScreen } from '../components/AuthScreen'

type SignInSearch = {
  returnTo?: string
}

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): SignInSearch => {
    return typeof search.returnTo === 'string' ? { returnTo: search.returnTo } : {}
  },
  component: SignInRoute,
})

function SignInRoute() {
  return <AuthScreen returnTo={Route.useSearch().returnTo} />
}
