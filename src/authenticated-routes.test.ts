import { isRedirect } from '@tanstack/react-router'
import { describe, expect, it, vi } from 'vitest'
import {
  createInviteExecutionRegistry,
  historyForSession,
  projectAuthenticatedBootstrap,
  requireAuthenticatedBootstrap,
  safeReturnTo,
  type AuthenticatedBootstrap,
} from './authenticated-routes'
import {
  authenticatedProviderKey,
  bootstrapForSession,
  isCurrentRoomStreamEvent,
} from './authenticated-app-state'
import { createDeck } from './game/card'
import { createGame } from './game/deal'
import type { PartyView, RoomView } from './multiplayer'
import { projectGame } from './multiplayer'
import { getRouter } from './router'

const room = {
  id: 'room-id',
  code: 'TABLE1',
  status: 'playing',
  version: 3,
  hostUserId: 'user-id',
  partyId: null,
  viewerSeat: 0,
  rules: {
    stickDealer: true,
    requireNaturalTrump: false,
    allowAloneWhenOrderingPartner: false,
    allowFarmersHand: false,
  },
  seats: [],
  game: projectGame(createGame(createDeck()), 0),
  disconnectVote: null,
  rematch: null,
} satisfies RoomView

const party = {
  id: 'party-id',
  ownerUserId: 'user-id',
  inviteCode: 'PARTY1',
  members: [{ userId: 'user-id', name: 'Player' }],
} satisfies PartyView

const bootstrap: AuthenticatedBootstrap = {
  session: { user: { id: 'user-id', name: 'Player' } },
  room,
  party,
}

describe('authenticated route structure', () => {
  it('keeps authenticated URLs under one pathless persistent layout', () => {
    const router = getRouter()
    const authenticated = router.routesById['/_authenticated']

    expect(authenticated.fullPath).toBe('/')
    expect(authenticated.options.beforeLoad).toBeTypeOf('function')
    expect(authenticated.options.loader).toBeTypeOf('function')
    expect(router.routesById['/_authenticated/'].parentRoute).toBe(authenticated)
    expect(router.routesById['/_authenticated/history'].parentRoute).toBe(authenticated)
    expect(router.routesById['/_authenticated/games/$code'].parentRoute).toBe(authenticated)
    expect(router.routesById['/_authenticated/partners/$code'].parentRoute).toBe(authenticated)
    expect(router.routesById['/_authenticated/history'].fullPath).toBe('/history')
    expect(router.routesById['/_authenticated/games/$code'].fullPath).toBe('/games/$code')
  })

  it('loads history but never gives invite routes a loader mutation', () => {
    const router = getRouter()

    expect(router.routesById['/_authenticated/history'].options.loader).toBeTypeOf('function')
    expect(router.routesById['/_authenticated/games/$code'].options.loader).toBeUndefined()
    expect(router.routesById['/_authenticated/partners/$code'].options.loader).toBeUndefined()
  })

  it('redirects direct unauthenticated links with the complete return path', () => {
    try {
      requireAuthenticatedBootstrap(null, '/games/TABLE1?source=invite#seat')
      throw new Error('Expected an authentication redirect')
    } catch (error) {
      expect(isRedirect(error)).toBe(true)
      expect(error).toMatchObject({
        options: {
          to: '/sign-in',
          search: { returnTo: '/games/TABLE1?source=invite#seat' },
        },
      })
    }
    expect(requireAuthenticatedBootstrap(bootstrap, '/history')).toBe(bootstrap)
  })
})

describe('bootstrap privacy', () => {
  it('serializes only the public session and projected multiplayer views', () => {
    const privateSession = {
      user: { id: 'user-id', name: 'Player', email: 'private@example.com' },
      session: { token: 'secret', ipAddress: '127.0.0.1' },
    }
    const projected = projectAuthenticatedBootstrap(privateSession, room, party)
    const serialized = JSON.stringify(projected)

    expect(projected.session).toEqual({ user: { id: 'user-id', name: 'Player' } })
    for (const hiddenField of [
      'token',
      'email',
      'ipAddress',
      'hands',
      'kitty',
      'initialHands',
      'ratingParticipants',
    ]) {
      expect(serialized).not.toContain(`"${hiddenField}"`)
    }
  })
})

describe('authentication return paths', () => {
  it('accepts relative and absolute same-origin paths', () => {
    expect(safeReturnTo('/history?view=all#recent', 'https://euchs.xyz')).toBe(
      '/history?view=all#recent',
    )
    expect(safeReturnTo('https://euchs.xyz/games/TABLE1', 'https://euchs.xyz')).toBe(
      '/games/TABLE1',
    )
  })

  it('rejects cross-origin and malformed return paths', () => {
    expect(safeReturnTo('https://attacker.example/steal', 'https://euchs.xyz')).toBe('/')
    expect(safeReturnTo('//attacker.example/steal', 'https://euchs.xyz')).toBe('/')
    expect(safeReturnTo('http://%', 'https://euchs.xyz')).toBe('/')
  })
})

describe('invite execution', () => {
  it('executes once per navigation even while the first execution is pending', async () => {
    const registry = createInviteExecutionRegistry()
    const operation = vi.fn(async () => {
      return 'joined'
    })

    const first = registry.run('navigation-1:room:TABLE1', operation)
    const duplicate = registry.run('navigation-1:room:TABLE1', operation)

    await expect(first).resolves.toBe('joined')
    await expect(duplicate).resolves.toBeUndefined()
    expect(operation).toHaveBeenCalledOnce()
  })

  it('allows the same invite on a later navigation', async () => {
    const registry = createInviteExecutionRegistry()
    const operation = vi.fn(async () => {
      return 'joined'
    })

    await registry.run('navigation-1:room:TABLE1', operation)
    await registry.run('navigation-2:room:TABLE1', operation)

    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('retries an invite after a provider remount', async () => {
    let currentParty: PartyView | null = null
    const operation = vi.fn(async () => {
      if (currentParty) {
        return currentParty
      }
      currentParty = party
      return currentParty
    })

    await createInviteExecutionRegistry().run('navigation-1:party:PARTY1', operation)
    await createInviteExecutionRegistry().run('navigation-1:party:PARTY1', operation)

    expect(operation).toHaveBeenCalledTimes(2)
    expect(currentParty).toBe(party)
  })
})

describe('authenticated provider scope', () => {
  it('blocks an old bootstrap and creates fresh provider state when identity changes', () => {
    const oldBootstrap = bootstrap
    const nextBootstrap: AuthenticatedBootstrap = {
      session: { user: { id: 'next-user-id', name: 'Next Player' } },
      room: null,
      party: null,
    }

    expect(bootstrapForSession(nextBootstrap.session, oldBootstrap)).toBeNull()
    expect(bootstrapForSession(nextBootstrap.session, nextBootstrap)).toBe(nextBootstrap)
    expect(authenticatedProviderKey(nextBootstrap)).not.toBe(authenticatedProviderKey(oldBootstrap))
    expect(JSON.stringify(nextBootstrap)).not.toContain(JSON.stringify(room.game?.hand))
  })

  it('rejects an A stream event after switching the active room to B', () => {
    expect(isCurrentRoomStreamEvent('room-a', 'room-b', 'room-a')).toBe(false)
    expect(isCurrentRoomStreamEvent('room-a', 'room-b', 'room-b')).toBe(false)
    expect(isCurrentRoomStreamEvent('room-b', 'room-b', 'room-b')).toBe(true)
  })
})

describe('history identity scope', () => {
  it('rejects an in-flight history response after the cookie session switches users', async () => {
    let returnOldHistory!: (result: { userId: string; history: [] }) => void
    const historyRequest = new Promise<{ userId: string; history: [] }>((resolve) => {
      returnOldHistory = resolve
    })
    let parentSession = bootstrap.session

    parentSession = { user: { id: 'next-user-id', name: 'Next Player' } }
    returnOldHistory({ userId: 'user-id', history: [] })
    const oldResult = await historyRequest

    expect(historyForSession(bootstrap.session, oldResult)).toBe(oldResult.history)
    expect(historyForSession(parentSession, oldResult)).toBeNull()
  })
})
