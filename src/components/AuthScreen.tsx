import { useState, type FormEvent } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { safeReturnTo } from '../authenticated-routes'
import { authClient } from '../lib/auth-client'
import { Brand } from './Brand'
import { HowToPlay } from './HowToPlay'

export function AuthScreen({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate()
  const router = useRouter()
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email'))
    const password = String(data.get('password'))
    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({ email, password, name: String(data.get('name')) })
        : await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) {
      setError(result.error.message ?? 'Authentication failed.')
    } else {
      await router.invalidate()
      const destination = new URL(
        safeReturnTo(returnTo, window.location.origin),
        window.location.origin,
      )
      const gameInvite = destination.pathname.match(/^\/games\/([^/]+)$/)
      const partnerInvite = destination.pathname.match(/^\/partners\/([^/]+)$/)
      const search = Object.fromEntries(destination.searchParams)
      const hash = destination.hash.slice(1)
      if (gameInvite) {
        await navigate({
          to: '/games/$code',
          params: { code: gameInvite[1] },
          search,
          hash,
          replace: true,
        })
      } else if (partnerInvite) {
        await navigate({
          to: '/partners/$code',
          params: { code: partnerInvite[1] },
          search,
          hash,
          replace: true,
        })
      } else if (destination.pathname === '/history') {
        await navigate({ to: '/history', search, hash, replace: true })
      } else {
        const room = destination.searchParams.get('room') ?? undefined
        await navigate({ to: '/', search: room ? { room } : {}, hash, replace: true })
      }
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand />
        <div>
          <span className="eyebrow">Private tables</span>
          <h1>{mode === 'sign-in' ? 'Take your seat.' : 'Join the table.'}</h1>
          <p>Online Euchre for one or four players.</p>
        </div>
        <form onSubmit={submit}>
          {mode === 'sign-up' && (
            <label>
              Name
              <input name="name" required minLength={2} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={pending}>
            {pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="auth-secondary-actions">
          <button
            className="quiet-button"
            onClick={() => {
              return setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
            }}
          >
            {mode === 'sign-in' ? 'Create an account' : 'Already have an account'}
          </button>
          <HowToPlay label="How to play" />
        </div>
      </section>
    </main>
  )
}
