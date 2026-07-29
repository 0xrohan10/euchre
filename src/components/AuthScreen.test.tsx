// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthScreen } from './AuthScreen'

const mocks = vi.hoisted(() => {
  return {
    signIn: vi.fn(),
    signUp: vi.fn(),
    navigate: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    hardNavigateHome: vi.fn(),
  }
})

vi.mock('@tanstack/react-router', () => {
  return {
    useNavigate: () => {
      return mocks.navigate
    },
    useRouter: () => {
      return { invalidate: mocks.invalidate }
    },
  }
})

vi.mock('../lib/auth-client', () => {
  return {
    authClient: {
      signIn: { email: mocks.signIn },
      signUp: { email: mocks.signUp },
    },
  }
})

vi.mock('../hard-navigation', () => {
  return { hardNavigateHome: mocks.hardNavigateHome }
})

vi.mock('../interaction-feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-feedback')>()
  return {
    ...actual,
    withRequestDeadline: <T,>(request: () => Promise<T>, timeoutMs?: number) => {
      return actual.withRequestDeadline(request, Math.min(timeoutMs ?? 10, 10))
    },
  }
})

vi.mock('./Brand', () => {
  return {
    Brand: () => {
      return <div>Card Party</div>
    },
  }
})

vi.mock('./HowToPlay', () => {
  return {
    HowToPlay: () => {
      return <button type="button">How to play</button>
    },
  }
})

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.signIn.mockReset()
  mocks.signUp.mockReset()
  mocks.navigate.mockResolvedValue(undefined)
  mocks.invalidate.mockResolvedValue(undefined)
})

function submitSignIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'player@example.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } })
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form')!)
}

function deferredAuthentication() {
  let resolve!: (result: { error?: unknown }) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<{ error?: unknown }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('AuthScreen', () => {
  it('observes late authentication success and reconciles the session after the deadline', async () => {
    const authentication = deferredAuthentication()
    mocks.signIn.mockReturnValue(authentication.promise)
    render(<AuthScreen />)

    submitSignIn()

    expect((await screen.findByRole('alert')).textContent).toContain('still being confirmed')
    authentication.resolve({})
    await waitFor(() => {
      expect(mocks.invalidate).toHaveBeenCalledOnce()
      expect(mocks.navigate).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('blocks attempt B while timed-out attempt A later succeeds', async () => {
    const attemptA = deferredAuthentication()
    mocks.signIn.mockReturnValueOnce(attemptA.promise).mockResolvedValueOnce({})
    render(<AuthScreen />)

    submitSignIn()
    await screen.findByRole('alert')
    const form = screen.getByRole('button', { name: 'Signing in…' }).closest('form')!
    fireEvent.submit(form)

    expect(mocks.signIn).toHaveBeenCalledOnce()
    expect(
      (screen.getByRole('button', { name: 'Signing in…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    attemptA.resolve({})
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledOnce()
    })
    expect(mocks.signIn).toHaveBeenCalledOnce()
  })

  it('allows attempt B only after timed-out attempt A definitively rejects', async () => {
    const attemptA = deferredAuthentication()
    mocks.signIn.mockReturnValueOnce(attemptA.promise).mockResolvedValueOnce({})
    render(<AuthScreen />)

    submitSignIn()
    await screen.findByRole('alert')
    fireEvent.submit(screen.getByRole('button', { name: 'Signing in…' }).closest('form')!)
    expect(mocks.signIn).toHaveBeenCalledOnce()

    attemptA.reject(new Error('attempt A rejected'))
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
        false,
      )
    })
    submitSignIn()

    await waitFor(() => {
      expect(mocks.signIn).toHaveBeenCalledTimes(2)
      expect(mocks.navigate).toHaveBeenCalledOnce()
    })
  })

  it('uses the hard home fallback without reporting auth failure after confirmed success', async () => {
    mocks.signIn.mockResolvedValue({})
    mocks.invalidate.mockRejectedValue(new Error('router failed'))
    render(<AuthScreen />)

    submitSignIn()

    await waitFor(() => {
      expect(mocks.hardNavigateHome).toHaveBeenCalledOnce()
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports an authentication rejection without treating it as a routing failure', async () => {
    mocks.signIn.mockResolvedValue({ error: new Error('denied') })
    render(<AuthScreen />)

    submitSignIn()

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not sign in with those details.',
    )
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.hardNavigateHome).not.toHaveBeenCalled()
  })
})
