import type { GameAction } from './game/state'

export const REQUEST_DEADLINE_MS = 10_000

export class RequestDeadlineError extends Error {
  constructor() {
    super('Request deadline exceeded')
    this.name = 'RequestDeadlineError'
  }
}

export class UnknownCommandOutcomeError extends Error {
  constructor() {
    super('The command outcome is unknown')
    this.name = 'UnknownCommandOutcomeError'
  }
}

export async function withRequestDeadline<T>(
  request: () => Promise<T>,
  timeoutMs = REQUEST_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RequestDeadlineError())
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

export async function submitIdempotentCommand<Command, Result>(
  command: Command,
  submit: (command: Command) => Promise<Result>,
  timeoutMs = REQUEST_DEADLINE_MS,
): Promise<Result> {
  try {
    return await withRequestDeadline(() => {
      return submit(command)
    }, timeoutMs)
  } catch (error) {
    if (!(error instanceof RequestDeadlineError)) {
      throw error
    }
  }

  try {
    return await withRequestDeadline(() => {
      return submit(command)
    }, timeoutMs)
  } catch (error) {
    if (error instanceof RequestDeadlineError) {
      throw new UnknownCommandOutcomeError()
    }
    throw error
  }
}

export async function submitIdempotentOperation<Operation, Result>(
  operation: Operation,
  submit: (operation: Operation) => Promise<Result>,
  timeoutMs = REQUEST_DEADLINE_MS,
): Promise<Result> {
  try {
    return await withRequestDeadline(() => {
      return submit(operation)
    }, timeoutMs)
  } catch (error) {
    if (!(error instanceof RequestDeadlineError)) {
      throw error
    }
  }

  return withRequestDeadline(() => {
    return submit(operation)
  }, timeoutMs)
}

export async function completeSignOut({
  revoke,
  clearAuthenticatedState,
  invalidate,
  navigateToSignIn,
  fallbackToSignIn,
}: {
  revoke: () => Promise<{ error?: unknown }>
  clearAuthenticatedState: () => void
  invalidate: () => Promise<unknown>
  navigateToSignIn: () => Promise<unknown>
  fallbackToSignIn: () => void
}): Promise<'revocation-failed' | 'revocation-pending' | 'signed-out'> {
  clearAuthenticatedState()
  let navigation: Promise<void> | undefined
  const forceSignInNavigation = () => {
    if (!navigation) {
      navigation = (async () => {
        try {
          await withRequestDeadline(invalidate)
          await withRequestDeadline(navigateToSignIn)
        } catch {
          fallbackToSignIn()
        }
      })()
    }
    return navigation
  }
  let revocation: Promise<{ error?: unknown }>
  try {
    revocation = Promise.resolve(revoke())
  } catch (error) {
    revocation = Promise.reject(error)
  }
  void revocation.then(
    (result) => {
      if (!result.error) {
        void forceSignInNavigation()
      }
    },
    () => {},
  )

  let result: { error?: unknown }
  try {
    result = await withRequestDeadline(() => {
      return revocation
    })
  } catch (error) {
    return error instanceof RequestDeadlineError ? 'revocation-pending' : 'revocation-failed'
  }
  if (result.error) {
    return 'revocation-failed'
  }
  await forceSignInNavigation()
  return 'signed-out'
}

export type LiveConnectionState = {
  status: 'live' | 'reconnecting' | 'stale'
  snapshotTrusted: boolean
}

export const STALE_CONNECTION: LiveConnectionState = {
  status: 'stale',
  snapshotTrusted: false,
}

export function connectionStatusLabel(state: LiveConnectionState): string {
  switch (state.status) {
    case 'live':
      return 'Live'
    case 'reconnecting':
      return state.snapshotTrusted ? 'Reconnecting' : 'Reconnecting, actions paused'
    case 'stale':
      return 'Connection stale, actions paused'
  }
}

export function gameActionPendingLabel(action: GameAction): string {
  switch (action.type) {
    case 'play':
      return 'Playing card…'
    case 'discard':
      return 'Discarding card…'
    case 'pass':
      return 'Passing…'
    case 'order-up':
      return 'Ordering up…'
    case 'call-trump':
      return 'Calling trump…'
    case 'exchange-kitty':
      return 'Swapping with kitty…'
    case 'decline-exchange':
      return 'Keeping hand…'
    case 'next-hand':
      return 'Starting next hand…'
    case 'new-match':
      return 'Starting new game…'
    default:
      return 'Updating table…'
  }
}
