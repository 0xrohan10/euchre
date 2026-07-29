// @vitest-environment jsdom
import type { ReactElement, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGame } from '../game/deal'
import { DEFAULT_RULES } from '../game/rules'
import { projectGame, type RoomView } from '../multiplayer'
import { GameTable } from './GameTable'
import { Lobby } from './Lobby'

const server = vi.hoisted(() => {
  return {
    createPartyFn: vi.fn(),
    createRoomFn: vi.fn(),
    createSinglePlayerRoomFn: vi.fn(),
    getRoomForCreationFn: vi.fn(),
    joinRoomFn: vi.fn(),
    leavePartyFn: vi.fn(),
    leaveRoomFn: vi.fn(),
    startPartyRoomFn: vi.fn(),
  }
})

vi.mock('../server/game.functions', () => {
  return server
})

vi.mock('@tanstack/react-router', () => {
  return {
    Link: ({ children }: { children: ReactNode }) => {
      return <a>{children}</a>
    },
  }
})

const seats: RoomView['seats'] = [0, 1, 2, 3].map((seat) => {
  return {
    seat,
    userId: `user-${seat}`,
    name: `Player ${seat}`,
    controller: 'human',
    connected: true,
    rating: 1500,
    ratingGames: 1,
    ratingMode: 'competitive',
  }
}) as RoomView['seats']

function room(status: RoomView['status']): RoomView {
  return {
    id: 'room-1',
    code: 'ABC123',
    status,
    version: 1,
    hostUserId: 'user-0',
    partyId: null,
    viewerSeat: 0,
    rules: DEFAULT_RULES,
    seats,
    game: status === 'lobby' ? null : projectGame(createGame(), 0),
    disconnectVote: null,
    rematch: null,
  }
}

function lobby(overrides: Partial<Parameters<typeof Lobby>[0]> = {}) {
  return (
    <Lobby
      room={null}
      party={null}
      onRoom={vi.fn()}
      onParty={vi.fn()}
      onLeave={vi.fn()}
      userId="user-1"
      userName="Player"
      connection={{ status: 'stale', snapshotTrusted: false }}
      onSignOut={vi.fn()}
      {...overrides}
    />
  )
}

async function expectCleanHydration(element: ReactElement) {
  const errors: unknown[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  container.innerHTML = renderToString(element)
  let root: ReturnType<typeof hydrateRoot> | undefined
  try {
    await act(async () => {
      root = hydrateRoot(container, element)
    })
    expect(errors).toEqual([])
  } finally {
    await act(async () => {
      root?.unmount()
    })
    console.error = originalError
    container.remove()
  }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe('Lobby room creation feedback', () => {
  it('reconciles a committed room after its creation response is lost', async () => {
    const committedRoom = room('playing')
    server.createSinglePlayerRoomFn.mockRejectedValue(new Error('response lost'))
    server.getRoomForCreationFn.mockResolvedValue(committedRoom)
    const onRoom = vi.fn()
    render(lobby({ onRoom }))

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))

    await waitFor(() => {
      expect(onRoom).toHaveBeenCalledWith(committedRoom)
    })
    expect(onRoom).toHaveBeenCalledOnce()
    expect(server.getRoomForCreationFn).toHaveBeenCalledWith({
      data: {
        operationId: server.createSinglePlayerRoomFn.mock.calls[0][0].data.operationId,
        kind: 'single-player',
      },
    })
  })

  it('retains one operation after an ambiguous rejection so the next click gets one room', async () => {
    const committedRoom = room('playing')
    server.createSinglePlayerRoomFn
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce(committedRoom)
    server.getRoomForCreationFn.mockRejectedValue(new TypeError('lookup network failed'))
    const onRoom = vi.fn()
    render(lobby({ onRoom }))

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('may still complete')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))

    await waitFor(() => {
      expect(onRoom).toHaveBeenCalledWith(committedRoom)
    })
    const requests = server.createSinglePlayerRoomFn.mock.calls.map((call) => {
      return call[0].data
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toBe(requests[0])
    expect(onRoom).toHaveBeenCalledOnce()
  })

  it('clears identity only after a definitive domain rejection with no recorded room', async () => {
    server.createSinglePlayerRoomFn
      .mockResolvedValueOnce({ outcome: 'rejected' })
      .mockImplementationOnce(() => {
        return new Promise(() => {})
      })
    server.getRoomForCreationFn.mockResolvedValue(null)
    render(lobby())

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not open')
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await Promise.resolve()
    })

    const requests = server.createSinglePlayerRoomFn.mock.calls.map((call) => {
      return call[0].data
    })
    expect(requests).toHaveLength(2)
    expect(requests[1].operationId).not.toBe(requests[0].operationId)
  })

  it('reuses one operation ID after two timeouts and applies a late first commit', async () => {
    vi.useFakeTimers()
    let commitFirst!: (value: RoomView) => void
    server.createSinglePlayerRoomFn
      .mockImplementationOnce(() => {
        return new Promise((resolve) => {
          commitFirst = resolve
        })
      })
      .mockImplementation(() => {
        return new Promise(() => {})
      })
    const onRoom = vi.fn()
    render(lobby({ onRoom }))

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(server.createSinglePlayerRoomFn).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).toContain('may still complete')

    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(server.createSinglePlayerRoomFn).toHaveBeenCalledTimes(3)
    const requests = server.createSinglePlayerRoomFn.mock.calls.map((call) => {
      return call[0].data
    })
    expect(requests[1]).toBe(requests[0])
    expect(requests[2]).toBe(requests[0])

    const committedRoom = room('playing')
    await act(async () => {
      commitFirst(committedRoom)
      await Promise.resolve()
    })
    expect(onRoom).toHaveBeenCalledTimes(1)
    expect(onRoom).toHaveBeenCalledWith(committedRoom)
  })

  it('pins displayed and retried rules while a creation outcome is ambiguous', async () => {
    vi.useFakeTimers()
    server.createSinglePlayerRoomFn.mockImplementation(() => {
      return new Promise(() => {})
    })
    render(lobby())

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    const stickDealer = screen.getByRole('checkbox', {
      name: /Stick the dealer/,
    }) as HTMLInputElement
    expect(stickDealer.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(screen.getByText(/Other table actions are locked/)).toBeTruthy()
    expect(stickDealer.disabled).toBe(true)
    fireEvent.click(stickDealer)
    expect(stickDealer.checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await Promise.resolve()
    })

    const requests = server.createSinglePlayerRoomFn.mock.calls.map((call) => {
      return call[0].data
    })
    expect(requests).toHaveLength(3)
    expect(requests[2]).toBe(requests[0])
    expect(requests[2].rules.stickDealer).toBe(true)
  })

  it('locks navigation during ambiguous creation and still applies late success', async () => {
    vi.useFakeTimers()
    let commitOriginal!: (value: RoomView) => void
    server.createSinglePlayerRoomFn
      .mockImplementationOnce(() => {
        return new Promise((resolve) => {
          commitOriginal = resolve
        })
      })
      .mockImplementation(() => {
        return new Promise(() => {})
      })
    const onRoom = vi.fn()
    render(lobby({ onRoom }))

    fireEvent.click(screen.getByRole('button', { name: /Single player/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start game' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })

    expect(screen.getByText(/late success will open automatically/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Start game' }) as HTMLButtonElement).disabled).toBe(
      false,
    )

    const committedRoom = room('playing')
    await act(async () => {
      commitOriginal(committedRoom)
      await Promise.resolve()
    })
    expect(onRoom).toHaveBeenCalledOnce()
    expect(onRoom).toHaveBeenCalledWith(committedRoom)
  })

  it('server-renders and hydrates a waiting lobby without render-time location access', async () => {
    await expectCleanHydration(lobby({ room: room('lobby') }))
  })

  it('server-renders and hydrates an active table without render-time location access', async () => {
    const activeRoom = room('playing')
    await expectCleanHydration(
      <GameTable
        room={activeRoom}
        connection={{ status: 'live', snapshotTrusted: true }}
        onRoom={vi.fn()}
        onLeave={vi.fn()}
        onSignOut={vi.fn()}
      />,
    )
  })
})
