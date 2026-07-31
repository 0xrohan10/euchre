import { useId, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { safeReturnTo } from '../authenticated-routes'
import { hardNavigateHome } from '../hard-navigation'
import { authClient } from '../lib/auth-client'
import { RequestDeadlineError, withRequestDeadline } from '../interaction-feedback'
import { Brand } from './Brand'
import { HowToPlay } from './HowToPlay'

export function AuthScreen({ returnTo }: { returnTo?: string }) {
  const navigate = useNavigate()
  const router = useRouter()
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState('')
  const [operation, setOperation] = useState<'sign-in' | 'sign-up' | null>(null)
  const errorId = useId()
  const submission = useRef(0)
  const authenticationPending = useRef(false)
  const authConfirmed = useRef(false)

  async function routeAfterAuthentication() {
    try {
      await withRequestDeadline(() => {
        return router.invalidate()
      })
      const destination = new URL(
        safeReturnTo(returnTo, window.location.origin),
        window.location.origin,
      )
      const gameInvite = destination.pathname.match(/^\/games\/([^/]+)$/)
      const partnerInvite = destination.pathname.match(/^\/partners\/([^/]+)$/)
      const search = Object.fromEntries(destination.searchParams)
      const hash = destination.hash.slice(1)
      if (gameInvite) {
        await withRequestDeadline(() => {
          return navigate({
            to: '/games/$code',
            params: { code: gameInvite[1] },
            search,
            hash,
            replace: true,
          })
        })
      } else if (partnerInvite) {
        await withRequestDeadline(() => {
          return navigate({
            to: '/partners/$code',
            params: { code: partnerInvite[1] },
            search,
            hash,
            replace: true,
          })
        })
      } else if (destination.pathname === '/history') {
        await withRequestDeadline(() => {
          return navigate({ to: '/history', search, hash, replace: true })
        })
      } else {
        const room = destination.searchParams.get('room') ?? undefined
        await withRequestDeadline(() => {
          return navigate({ to: '/', search: room ? { room } : {}, hash, replace: true })
        })
      }
    } catch {
      hardNavigateHome()
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (authenticationPending.current) {
      return
    }
    authenticationPending.current = true
    const submittedMode = mode
    const submittedGeneration = ++submission.current
    setOperation(submittedMode)
    setError('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email'))
    const password = String(data.get('password'))
    let authentication: Promise<{ error?: unknown }>
    try {
      authentication = Promise.resolve(
        submittedMode === 'sign-up'
          ? authClient.signUp.email({ email, password, name: String(data.get('name')) })
          : authClient.signIn.email({ email, password }),
      )
    } catch {
      authentication = Promise.reject(new Error('Authentication request failed.'))
    }

    const settlement = authentication.then(
      async (result) => {
        if (result.error) {
          if (!authConfirmed.current && submission.current === submittedGeneration) {
            setError(
              submittedMode === 'sign-in'
                ? 'Could not sign in with those details.'
                : 'Could not create that account.',
            )
          }
          return
        }
        authConfirmed.current = true
        if (submission.current === submittedGeneration) {
          setError('')
        }
        await routeAfterAuthentication()
      },
      () => {
        if (!authConfirmed.current && submission.current === submittedGeneration) {
          setError(
            submittedMode === 'sign-in'
              ? 'Could not sign in. Please try again.'
              : 'Could not create your account. Please try again.',
          )
        }
      },
    )
    void settlement.finally(() => {
      if (submission.current === submittedGeneration) {
        authenticationPending.current = false
        setOperation(null)
      }
    })

    try {
      await withRequestDeadline(() => {
        return settlement
      })
    } catch (cause) {
      if (
        cause instanceof RequestDeadlineError &&
        !authConfirmed.current &&
        submission.current === submittedGeneration
      ) {
        setError(
          'Authentication is still being confirmed. Keep this page open; you can retry after it settles.',
        )
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
        <form onSubmit={submit} aria-busy={operation !== null}>
          {mode === 'sign-up' && (
            <label>
              Name
              <input
                name="name"
                required
                minLength={2}
                autoComplete="name"
                disabled={operation !== null}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
              />
            </label>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              disabled={operation !== null}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
              disabled={operation !== null}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
            />
          </label>
          {error && (
            <p className="form-error" id={errorId} role="alert">
              {error}
            </p>
          )}
          <button className="primary-button" disabled={operation !== null}>
            {operation === 'sign-in'
              ? 'Signing in…'
              : operation === 'sign-up'
                ? 'Creating account…'
                : mode === 'sign-in'
                  ? 'Sign in'
                  : 'Create account'}
          </button>
        </form>
        <div className="auth-secondary-actions">
          <button
            className="quiet-button"
            disabled={operation !== null}
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
