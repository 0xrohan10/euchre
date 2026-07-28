import { useState, type FormEvent } from 'react'
import { authClient } from '../lib/auth-client'
import { Brand } from './Brand'
import { HowToPlay } from './HowToPlay'

export function AuthScreen() {
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
      window.location.reload()
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
