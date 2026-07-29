// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedBootstrap } from '../authenticated-routes'
import type { PartyView, RoomView } from '../multiplayer'
import { AuthenticatedAppProvider, useAuthenticatedApp } from './AuthenticatedAppProvider'

const mocks = vi.hoisted(() => {
  return {
    signOut: vi.fn(),
    navigate: vi.fn().mockResolvedValue(undefined),
    invalidate: vi.fn().mockResolvedValue(undefined),
    historyReplace: vi.fn(),
    startLobbyTransport: vi.fn(() => {
      return { stop: vi.fn() }
    }),
    startRoomTransport: vi.fn(() => {
      return { stop: vi.fn() }
    }),
  }
})

vi.mock('@tanstack/react-router', () => {
  return {
    useLocation: () => {
      return { pathname: '/' }
    },
    useNavigate: () => {
      return mocks.navigate
    },
    useRouter: () => {
      return { invalidate: mocks.invalidate, history: { replace: mocks.historyReplace } }
    },
  }
})

vi.mock('../lib/auth-client', () => {
  return { authClient: { signOut: mocks.signOut } }
})

vi.mock('../live-event-source', () => {
  return {
    getPageConnectionIdentity: () => {
      return 'page-1'
    },
    startLiveEventSource: mocks.startRoomTransport,
  }
})

vi.mock('../lobby-live-transport', () => {
  return { startLobbyLiveTransport: mocks.startLobbyTransport }
})

vi.mock('../server/game.functions', () => {
  return {
    getCurrentPartyFn: vi.fn(),
    getWaitingLobbyFn: vi.fn(),
  }
})

const bootstrap: AuthenticatedBootstrap = {
  session: { user: { id: 'user-1', name: 'Player' } },
  room: null,
  party: null,
}

function PrivateApp() {
  const { signOut } = useAuthenticatedApp()
  return (
    <div>
      <span>Private game data</span>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </div>
  )
}

function LateMutationApp({
  invite,
  creation,
}: {
  invite: Promise<PartyView>
  creation: Promise<RoomView>
}) {
  const { openRoom, setParty, signOut } = useAuthenticatedApp()
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void invite.then(setParty)
        }}
      >
        Start invite
      </button>
      <button
        type="button"
        onClick={() => {
          void creation.then(openRoom)
        }}
      >
        Start creation
      </button>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </div>
  )
}

function OpenRoomApp({ nextRoom }: { nextRoom: RoomView }) {
  const { loadError, openRoom, room } = useAuthenticatedApp()
  return (
    <div>
      <span>{room?.id ?? 'No room'}</span>
      <span>{loadError}</span>
      <button
        type="button"
        onClick={() => {
          void openRoom(nextRoom)
        }}
      >
        Open room
      </button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('AuthenticatedAppProvider sign-out shell', () => {
  it('keeps joined room state and falls back to the game when navigation rejects', async () => {
    const joinedRoom = { id: 'joined-room', code: 'JOIN01' } as RoomView
    mocks.navigate.mockRejectedValueOnce(new Error('router failed'))
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <OpenRoomApp nextRoom={joinedRoom} />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open room' }))

    expect(await screen.findByText('joined-room')).toBeTruthy()
    await waitFor(() => {
      expect(mocks.historyReplace).toHaveBeenCalledWith('/games/JOIN01')
    })
    expect(screen.queryByText(/Could not join|Could not open/)).toBeNull()
  })

  it('keeps joined room state and falls back when navigation never settles', async () => {
    vi.useFakeTimers()
    const joinedRoom = { id: 'joined-room', code: 'JOIN02' } as RoomView
    mocks.navigate.mockImplementationOnce(() => {
      return new Promise(() => {})
    })
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <OpenRoomApp nextRoom={joinedRoom} />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open room' }))
    expect(screen.getByText('joined-room')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(mocks.historyReplace).toHaveBeenCalledWith('/games/JOIN02')
    expect(screen.queryByText(/Could not join|Could not open/)).toBeNull()
  })

  it('keeps private children cleared through a timeout and navigates after late success', async () => {
    vi.useFakeTimers()
    let resolveRevocation!: (result: { error?: unknown }) => void
    mocks.signOut.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveRevocation = resolve
      })
    })
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <PrivateApp />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.queryByText('Private game data')).toBeNull()
    expect(screen.getByText('Signing out...')).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.queryByText('Private game data')).toBeNull()
    expect(screen.getByText('Sign-out status unknown')).toBeTruthy()
    expect(mocks.navigate).not.toHaveBeenCalled()

    await act(async () => {
      resolveRevocation({})
      await Promise.resolve()
    })
    expect(mocks.invalidate).toHaveBeenCalledOnce()
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sign-in', replace: true })
  })

  it('keeps failure visible and retries without restoring private children', async () => {
    mocks.signOut.mockResolvedValueOnce({ error: new Error('denied') }).mockResolvedValueOnce({})
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <PrivateApp />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not sign out')
    expect(screen.queryByText('Private game data')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry sign out' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('Private game data')).toBeNull()
    expect(mocks.signOut).toHaveBeenCalledTimes(2)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sign-in', replace: true })
  })

  it('makes a never-settling sign-out explicitly ambiguous and retryable', async () => {
    vi.useFakeTimers()
    mocks.signOut.mockImplementation(() => {
      return new Promise(() => {})
    })
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <PrivateApp />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(screen.getByRole('alert').textContent).toContain('response was lost')
    expect(screen.getByRole('button', { name: 'Retry sign out safely' })).toBeTruthy()
    expect(screen.queryByText('Private game data')).toBeNull()
  })

  it('keeps observing the original revocation while a safe retry is pending', async () => {
    vi.useFakeTimers()
    let resolveOriginal!: (result: { error?: unknown }) => void
    mocks.signOut
      .mockImplementationOnce(() => {
        return new Promise((resolve) => {
          resolveOriginal = resolve
        })
      })
      .mockImplementationOnce(() => {
        return new Promise(() => {})
      })
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <PrivateApp />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry sign out safely' }))
    expect(mocks.signOut).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveOriginal({})
      await Promise.resolve()
    })

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sign-in', replace: true })
    expect(screen.queryByText('Private game data')).toBeNull()
  })

  it('ignores late invite and creation mutations after sign-out invalidates authentication', async () => {
    let resolveInvite!: (party: PartyView) => void
    let resolveCreation!: (room: RoomView) => void
    const invite = new Promise<PartyView>((resolve) => {
      resolveInvite = resolve
    })
    const creation = new Promise<RoomView>((resolve) => {
      resolveCreation = resolve
    })
    mocks.signOut.mockImplementation(() => {
      return new Promise(() => {})
    })
    render(
      <AuthenticatedAppProvider bootstrap={bootstrap}>
        <LateMutationApp invite={invite} creation={creation} />
      </AuthenticatedAppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start invite' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start creation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await act(async () => {
      resolveInvite({ id: 'party-late' } as PartyView)
      resolveCreation({ id: 'room-late', code: 'LATE01' } as RoomView)
      await Promise.resolve()
    })

    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.startLobbyTransport).not.toHaveBeenCalled()
    expect(mocks.startRoomTransport).not.toHaveBeenCalled()
  })
})
