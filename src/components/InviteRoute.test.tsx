// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PartyView, RoomView } from '../multiplayer'
import { PartyInviteRoute, RoomInviteRoute } from './InviteRoute'

const mocks = vi.hoisted(() => {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    openRoom: vi.fn().mockResolvedValue(undefined),
    setParty: vi.fn(),
    setLoadError: vi.fn(),
    getCurrentPartyFn: vi.fn(),
    getCurrentRoomFn: vi.fn(),
    joinPartyFn: vi.fn(),
    joinRoomFn: vi.fn(),
  }
})

vi.mock('../App', () => {
  return {
    default: () => {
      return <div>App</div>
    },
  }
})

vi.mock('@tanstack/react-router', () => {
  return {
    useLocation: () => {
      return { state: { __TSR_key: 'navigation-1' }, href: '/invite' }
    },
    useNavigate: () => {
      return mocks.navigate
    },
  }
})

vi.mock('../server/game.functions', () => {
  return {
    getCurrentPartyFn: mocks.getCurrentPartyFn,
    getCurrentRoomFn: mocks.getCurrentRoomFn,
    joinPartyFn: mocks.joinPartyFn,
    joinRoomFn: mocks.joinRoomFn,
  }
})

vi.mock('./AuthenticatedAppProvider', () => {
  return {
    useAuthenticatedApp: () => {
      return {
        runInvite: (_key: string, operation: () => Promise<unknown>) => {
          return operation()
        },
        openRoom: mocks.openRoom,
        setParty: mocks.setParty,
        setLoadError: mocks.setLoadError,
      }
    },
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('invite deadline reconciliation', () => {
  it('reconciles a room timeout and still applies the original late join success', async () => {
    vi.useFakeTimers()
    let resolveJoin!: (room: RoomView) => void
    const joinedRoom = { id: 'joined-room', code: 'ABC123' } as RoomView
    mocks.joinRoomFn.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveJoin = resolve
      })
    })
    mocks.getCurrentRoomFn.mockResolvedValue(null)
    mocks.getCurrentPartyFn.mockResolvedValue(null)
    render(<RoomInviteRoute code="ABC123" />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.getCurrentRoomFn).toHaveBeenCalledOnce()
    expect(mocks.getCurrentPartyFn).toHaveBeenCalledOnce()
    expect(mocks.setLoadError).toHaveBeenCalledWith('Could not join that table. Please try again.')
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/', replace: true })

    await act(async () => {
      resolveJoin(joinedRoom)
      await Promise.resolve()
    })
    expect(mocks.openRoom).toHaveBeenCalledWith(joinedRoom)
  })

  it('lets a room join commit after null reconciliation before failure is applied', async () => {
    vi.useFakeTimers()
    let resolveJoin!: (room: RoomView) => void
    const joinedRoom = { id: 'joined-room', code: 'ABC123' } as RoomView
    mocks.joinRoomFn.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveJoin = resolve
      })
    })
    mocks.getCurrentRoomFn.mockResolvedValue(null)
    mocks.getCurrentPartyFn.mockResolvedValue(null)
    mocks.setParty.mockImplementationOnce(() => {
      resolveJoin(joinedRoom)
    })
    render(<RoomInviteRoute code="ABC123" />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(mocks.openRoom).toHaveBeenCalledWith(joinedRoom)
    expect(mocks.setLoadError).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('reconciles a party timeout and still applies the original late join success', async () => {
    vi.useFakeTimers()
    let resolveJoin!: (party: PartyView) => void
    const joinedParty = { id: 'joined-party' } as PartyView
    mocks.joinPartyFn.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveJoin = resolve
      })
    })
    mocks.getCurrentRoomFn.mockResolvedValue(null)
    mocks.getCurrentPartyFn.mockResolvedValue(null)
    render(<PartyInviteRoute code="PARTY1" />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(mocks.getCurrentRoomFn).toHaveBeenCalledOnce()
    expect(mocks.getCurrentPartyFn).toHaveBeenCalledOnce()
    expect(mocks.setLoadError).toHaveBeenCalledWith(
      'Could not join that partnership. Check the invite and try again.',
    )

    await act(async () => {
      resolveJoin(joinedParty)
      await Promise.resolve()
    })
    expect(mocks.setParty).toHaveBeenCalledWith(joinedParty)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })
})
