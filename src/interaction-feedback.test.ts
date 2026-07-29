import { describe, expect, it, vi } from 'vitest'
import {
  completeSignOut,
  connectionStatusLabel,
  gameActionPendingLabel,
  RequestDeadlineError,
  submitIdempotentCommand,
  UnknownCommandOutcomeError,
  withRequestDeadline,
} from './interaction-feedback'

describe('interaction feedback', () => {
  it('uses action-specific pending labels', () => {
    expect(gameActionPendingLabel({ type: 'play', cardId: 'nine-clubs' })).toBe('Playing card…')
    expect(gameActionPendingLabel({ type: 'call-trump', suit: 'hearts', alone: false })).toBe(
      'Calling trump…',
    )
    expect(gameActionPendingLabel({ type: 'next-hand' })).toBe('Starting next hand…')
  })

  it('distinguishes trusted reconnecting data from untrusted snapshots', () => {
    expect(connectionStatusLabel({ status: 'reconnecting', snapshotTrusted: true })).toBe(
      'Reconnecting',
    )
    expect(connectionStatusLabel({ status: 'reconnecting', snapshotTrusted: false })).toBe(
      'Reconnecting, actions paused',
    )
    expect(connectionStatusLabel({ status: 'stale', snapshotTrusted: false })).toBe(
      'Connection stale, actions paused',
    )
  })

  it('bounds a never-settling request and clears its deadline timer', async () => {
    vi.useFakeTimers()
    try {
      const request = withRequestDeadline(() => {
        return new Promise<never>(() => {})
      }, 1_000)
      const assertion = expect(request).rejects.toBeInstanceOf(RequestDeadlineError)
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a timed-out command once with the same immutable command identity', async () => {
    vi.useFakeTimers()
    try {
      const command = { commandId: 'command-1', expectedVersion: 7 }
      const submit = vi
        .fn<(next: typeof command) => Promise<{ status: string }>>()
        .mockImplementationOnce(() => {
          return new Promise(() => {})
        })
        .mockResolvedValueOnce({ status: 'applied' })
      const request = submitIdempotentCommand(command, submit, 1_000)

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(request).resolves.toEqual({ status: 'applied' })
      expect(submit).toHaveBeenCalledTimes(2)
      expect(submit.mock.calls[0]?.[0]).toBe(command)
      expect(submit.mock.calls[1]?.[0]).toBe(command)
      expect(command).toEqual({ commandId: 'command-1', expectedVersion: 7 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an unknown outcome after two bounded command attempts', async () => {
    vi.useFakeTimers()
    try {
      const submit = vi.fn(() => {
        return new Promise<never>(() => {})
      })
      const request = submitIdempotentCommand(
        { commandId: 'command-1', expectedVersion: 7 },
        submit,
        1_000,
      )
      const assertion = expect(request).rejects.toBeInstanceOf(UnknownCommandOutcomeError)

      await vi.advanceTimersByTimeAsync(2_000)

      await assertion
      expect(submit).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps revoked state cleared and falls back when routing fails', async () => {
    const calls: string[] = []
    const outcome = await completeSignOut({
      revoke: async () => {
        calls.push('revoke')
        return {}
      },
      clearAuthenticatedState: () => {
        calls.push('clear')
      },
      invalidate: async () => {
        calls.push('invalidate')
        throw new Error('router failed')
      },
      navigateToSignIn: async () => {
        calls.push('navigate')
      },
      fallbackToSignIn: () => {
        calls.push('fallback')
      },
    })

    expect(outcome).toBe('signed-out')
    expect(calls).toEqual(['clear', 'revoke', 'invalidate', 'fallback'])
  })

  it('keeps authenticated state cleared when revocation fails', async () => {
    const clearAuthenticatedState = vi.fn()
    const invalidate = vi.fn()
    const navigateToSignIn = vi.fn()
    const fallbackToSignIn = vi.fn()
    const outcome = await completeSignOut({
      revoke: async () => {
        return { error: new Error('denied') }
      },
      clearAuthenticatedState,
      invalidate,
      navigateToSignIn,
      fallbackToSignIn,
    })

    expect(outcome).toBe('revocation-failed')
    expect(clearAuthenticatedState).toHaveBeenCalledOnce()
    expect(invalidate).not.toHaveBeenCalled()
    expect(navigateToSignIn).not.toHaveBeenCalled()
    expect(fallbackToSignIn).not.toHaveBeenCalled()
  })

  it('keeps state cleared and forces sign-in navigation after late revocation success', async () => {
    vi.useFakeTimers()
    try {
      let settleRevocation!: (result: { error?: unknown }) => void
      const calls: string[] = []
      const request = completeSignOut({
        revoke: () => {
          calls.push('revoke')
          return new Promise((resolve) => {
            settleRevocation = resolve
          })
        },
        clearAuthenticatedState: () => {
          calls.push('clear')
        },
        invalidate: async () => {
          calls.push('invalidate')
        },
        navigateToSignIn: async () => {
          calls.push('navigate')
        },
        fallbackToSignIn: () => {
          calls.push('fallback')
        },
      })

      expect(calls).toEqual(['clear', 'revoke'])
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(request).resolves.toBe('revocation-pending')
      expect(calls).toEqual(['clear', 'revoke'])

      settleRevocation({})
      await vi.waitFor(() => {
        expect(calls).toEqual(['clear', 'revoke', 'invalidate', 'navigate'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back after a never-settling post-revocation router request', async () => {
    vi.useFakeTimers()
    try {
      const clearAuthenticatedState = vi.fn()
      const fallbackToSignIn = vi.fn()
      const request = completeSignOut({
        revoke: async () => {
          return {}
        },
        clearAuthenticatedState,
        invalidate: () => {
          return new Promise(() => {})
        },
        navigateToSignIn: vi.fn(),
        fallbackToSignIn,
      })

      await vi.advanceTimersByTimeAsync(10_000)

      await expect(request).resolves.toBe('signed-out')
      expect(clearAuthenticatedState).toHaveBeenCalledOnce()
      expect(fallbackToSignIn).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
