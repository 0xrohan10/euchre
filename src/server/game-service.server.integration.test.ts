import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import {
  activeRoomMembership,
  party,
  partyJoin,
  partyMember,
  room,
  roomSeat,
  user,
} from '../db/schema'
import { DEFAULT_RULES } from '../game/rules'
import { createGame } from '../game/deal'
import { createDeck } from '../game/card'
import type { PlayerAction } from '../multiplayer'
import { createGameRuntime, GameService } from './game-service.server'
import { Effect } from 'effect'

const runIntegration = process.env.RUN_DB_INTEGRATION === '1'

const describeIntegration = runIntegration ? describe : describe.skip

function uniqueId(label: string) {
  return `tick-int-${label}-${crypto.randomUUID()}`
}

describeIntegration('GameService.tick lock and race behavior', () => {
  const admin = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 6,
  })
  const queries: string[] = []
  const db = drizzle({
    client: admin,
    logger: {
      logQuery(query) {
        queries.push(query)
      },
    },
  })
  const gameRuntime = createGameRuntime(db)
  const createdUserIds: string[] = []
  const createdRoomIds: string[] = []
  const createdPartyIds: string[] = []

  afterEach(async () => {
    for (const roomId of createdRoomIds.splice(0)) {
      await admin.query('delete from room where id = $1', [roomId])
    }
    for (const partyId of createdPartyIds.splice(0)) {
      await admin.query('delete from party where id = $1', [partyId])
    }
    for (const userId of createdUserIds.splice(0)) {
      await admin.query('delete from "user" where id = $1', [userId])
    }
  })

  afterAll(async () => {
    await gameRuntime.dispose()
    await admin.end()
  })

  async function insertUser(label: string) {
    const id = uniqueId(label)
    createdUserIds.push(id)
    await db.insert(user).values({
      id,
      name: label,
      email: `${id}@example.test`,
      emailVerified: true,
    })
    return id
  }

  async function insertRoom(options: {
    hostUserId: string
    partnerUserId: string
    lastSeenAt: Date
    partnerLastSeenAt?: Date
    game?: ReturnType<typeof createGame> | null
    status?: 'lobby' | 'playing' | 'paused' | 'finished'
    updatedAt?: Date
    partyId?: string
  }) {
    const roomId = crypto.randomUUID()
    createdRoomIds.push(roomId)
    const updatedAt = options.updatedAt ?? new Date()
    await db.insert(room).values({
      id: roomId,
      code: crypto.randomUUID().slice(0, 6).toUpperCase(),
      hostUserId: options.hostUserId,
      partyId: options.partyId,
      rules: DEFAULT_RULES,
      status: options.status ?? 'playing',
      game: options.game === undefined ? createGame(createDeck(), DEFAULT_RULES) : options.game,
      version: 1,
      updatedAt,
      createdAt: updatedAt,
    })
    await db.insert(roomSeat).values([
      {
        roomId,
        seat: 0,
        userId: options.hostUserId,
        connected: true,
        controller: 'human',
        lastSeenAt: options.lastSeenAt,
      },
      {
        roomId,
        seat: 1,
        controller: 'bot',
        connected: false,
        lastSeenAt: options.lastSeenAt,
      },
      {
        roomId,
        seat: 2,
        userId: options.partnerUserId,
        connected: true,
        controller: 'human',
        lastSeenAt: options.partnerLastSeenAt ?? options.lastSeenAt,
      },
      {
        roomId,
        seat: 3,
        controller: 'bot',
        connected: false,
        lastSeenAt: options.lastSeenAt,
      },
    ])
    return roomId
  }

  async function insertLobby(hostUserId: string) {
    const roomId = crypto.randomUUID()
    const code = crypto.randomUUID().slice(0, 6).toUpperCase()
    createdRoomIds.push(roomId)
    await db.insert(room).values({
      id: roomId,
      code,
      hostUserId,
      rules: DEFAULT_RULES,
      status: 'lobby',
    })
    await db.insert(roomSeat).values({ roomId, seat: 0, userId: hostUserId, connected: true })
    return { code, roomId }
  }

  async function insertParty(ownerUserId: string, partnerUserId: string) {
    const [created] = await db.insert(party).values({ ownerUserId }).returning({ id: party.id })
    createdPartyIds.push(created.id)
    await db.insert(partyMember).values([
      { partyId: created.id, userId: ownerUserId },
      { partyId: created.id, userId: partnerUserId },
    ])
    return created.id
  }

  async function insertOpenParty(ownerUserId: string) {
    const [created] = await db
      .insert(party)
      .values({ ownerUserId })
      .returning({ id: party.id, inviteCode: party.inviteCode })
    createdPartyIds.push(created.id)
    await db.insert(partyMember).values({ partyId: created.id, userId: ownerUserId })
    return created
  }

  async function seatSnapshot(roomId: string, seatUserId: string) {
    const rows = await db.select().from(roomSeat).where(eq(roomSeat.roomId, roomId))
    const match = rows.find((row) => {
      return row.userId === seatUserId
    })
    if (!match) {
      throw new Error('seat missing')
    }
    return {
      connected: match.connected,
      controller: match.controller,
      lastSeenAt: match.lastSeenAt.getTime(),
    }
  }

  async function activeRoomIds(userId: string) {
    const result = await admin.query<{ id: string }>(
      `select room.id
       from room_seat
       join room on room.id = room_seat.room_id
       where room_seat.user_id = $1
         and room.status in ('lobby', 'playing', 'paused')
       order by room.id`,
      [userId],
    )
    return result.rows.map(({ id }) => {
      return id
    })
  }

  async function withRoomLockBarrier<T>(
    roomId: string,
    work: (hold: {
      client: pg.PoolClient
      release: (commit?: boolean) => Promise<void>
      waitForBlockedMutation: () => Promise<void>
    }) => Promise<T>,
  ) {
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('select id from room where id = $1 for update', [roomId])
      const holder = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      const holderPid = holder.rows[0]!.pid
      let released = false
      const release = async (commit = false) => {
        if (released) {
          return
        }
        released = true
        await client.query(commit ? 'commit' : 'rollback')
      }
      const waitForBlockedMutation = async () => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const blocked = await admin.query<{ blocked: boolean }>(
            `select exists (
              select 1
              from pg_stat_activity
              where pid <> $1
                and wait_event_type = 'Lock'
                and $1 = any(pg_blocking_pids(pid))
                and query ilike '%for update of "room"%'
            ) as blocked`,
            [holderPid],
          )
          if (blocked.rows[0]?.blocked) {
            return
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 10)
          })
        }
        throw new Error('Timed out waiting for a mutation to block on the room lock.')
      }
      try {
        return await work({ client, release, waitForBlockedMutation })
      } finally {
        await release()
      }
    } finally {
      client.release()
    }
  }

  async function withPartyLockBarrier<T>(
    partyId: string,
    work: (hold: {
      release: () => Promise<void>
      waitForBlockedJoins: (count: number) => Promise<void>
    }) => Promise<T>,
  ) {
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('select id from party where id = $1 for update', [partyId])
      const holder = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
      const holderPid = holder.rows[0]!.pid
      let released = false
      const release = async () => {
        if (released) {
          return
        }
        released = true
        await client.query('rollback')
      }
      const waitForBlockedJoins = async (count: number) => {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          const blocked = await admin.query<{ count: string }>(
            `select count(*)::text as count
             from pg_stat_activity
             where pid <> $1
               and wait_event_type = 'Lock'
               and query ilike '%for update of "party"%'`,
            [holderPid],
          )
          if (Number(blocked.rows[0]?.count) >= count) {
            return
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 10)
          })
        }
        throw new Error(`Timed out waiting for ${count} joins to block on the party lock.`)
      }
      try {
        return await work({ release, waitForBlockedJoins })
      } finally {
        await release()
      }
    } finally {
      client.release()
    }
  }

  async function withUserLockBarrier<T>(
    userId: string,
    work: (hold: {
      release: () => Promise<void>
      waitForBlockedTransitions: (count: number) => Promise<void>
    }) => Promise<T>,
  ) {
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('select id from "user" where id = $1 for no key update', [userId])
      let released = false
      const release = async () => {
        if (released) {
          return
        }
        released = true
        await client.query('rollback')
      }
      const waitForBlockedTransitions = async (count: number) => {
        await new Promise((resolve) => {
          setTimeout(resolve, count * 50)
        })
      }
      try {
        return await work({ release, waitForBlockedTransitions })
      } finally {
        await release()
      }
    } finally {
      client.release()
    }
  }

  function tick(userId: string, roomId: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.tick(userId, roomId)
      }),
    )
  }

  function getRoom(userId: string, roomId: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.getRoom(userId, roomId)
      }),
    )
  }

  function currentRoom(userId: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.currentRoom(userId)
      }),
    )
  }

  function createRoomForOperation(
    userId: string,
    operationId: string,
    kind: 'multiplayer' | 'single-player',
  ) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return kind === 'multiplayer'
          ? games.createRoom(userId, operationId, DEFAULT_RULES)
          : games.createSinglePlayerRoom(userId, operationId, DEFAULT_RULES)
      }),
    )
  }

  function roomForCreationOperation(
    userId: string,
    operationId: string,
    kind: 'multiplayer' | 'single-player',
  ) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.roomForCreationOperation(userId, operationId, kind)
      }),
    )
  }

  function joinParty(userId: string, inviteCode: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinParty(userId, inviteCode)
      }),
    )
  }

  function joinRoom(userId: string, code: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.joinRoom(userId, code)
      }),
    )
  }

  function startPartyRoom(userId: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.startPartyRoom(userId, DEFAULT_RULES)
      }),
    )
  }

  function submit(
    userId: string,
    command: {
      roomId: string
      commandId: string
      expectedVersion: number
      action: PlayerAction | { type: 'next-hand' } | { type: 'new-match' }
    },
  ) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.submit(userId, command)
      }),
    )
  }

  function voteForBot(userId: string, roomId: string, disconnectedSeat: 0 | 1 | 2 | 3) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.voteForBot(userId, roomId, disconnectedSeat, true)
      }),
    )
  }

  function confirmRematch(userId: string, roomId: string) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.confirmRematch(userId, roomId)
      }),
    )
  }

  function setPresence(userId: string, roomId: string, connected: boolean) {
    return gameRuntime.runPromise(
      Effect.flatMap(GameService, (games) => {
        return games.setPresence(userId, roomId, connected)
      }),
    )
  }

  async function capturedQueries<T>(work: () => Promise<T>) {
    queries.length = 0
    const result = await work()
    return {
      result,
      queries: queries.filter((query) => {
        return !/^(begin|commit|rollback)/i.test(query)
      }),
    }
  }

  it.each(['multiplayer', 'single-player'] as const)(
    'returns the same projected room for sequential duplicate %s creation',
    async (kind) => {
      const userId = await insertUser(`create-${kind}-sequential`)
      const operationId = crypto.randomUUID()

      const first = await createRoomForOperation(userId, operationId, kind)
      createdRoomIds.push(first.id)
      const second = await createRoomForOperation(userId, operationId, kind)

      expect(second).toEqual(first)
      const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
      expect(records).toEqual([{ id: first.id }])
    },
  )

  it.each(['multiplayer', 'single-player'] as const)(
    'reconciles a committed %s creation after response loss and keeps one room on retry',
    async (kind) => {
      const userId = await insertUser(`create-${kind}-response-loss`)
      const operationId = crypto.randomUUID()
      let committedRoomId = ''

      await expect(
        createRoomForOperation(userId, operationId, kind).then((created) => {
          committedRoomId = created.id
          createdRoomIds.push(created.id)
          throw new Error('response lost after commit')
        }),
      ).rejects.toThrow('response lost after commit')

      const reconciled = await roomForCreationOperation(userId, operationId, kind)
      const retried = await createRoomForOperation(userId, operationId, kind)
      expect(reconciled?.id).toBe(committedRoomId)
      expect(retried.id).toBe(committedRoomId)
      const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
      expect(records).toEqual([{ id: committedRoomId }])
    },
  )

  it.each(['multiplayer', 'single-player'] as const)(
    'returns the same projected room for concurrent duplicate %s creation',
    async (kind) => {
      const userId = await insertUser(`create-${kind}-concurrent`)
      const operationId = crypto.randomUUID()

      const [first, second] = await Promise.all([
        createRoomForOperation(userId, operationId, kind),
        createRoomForOperation(userId, operationId, kind),
      ])
      createdRoomIds.push(first.id)

      expect(second).toEqual(first)
      const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
      expect(records).toEqual([{ id: first.id }])
    },
  )

  it.each(['multiplayer', 'single-player'] as const)(
    'acquires one active room for concurrent %s creation with different operation IDs',
    async (kind) => {
      const userId = await insertUser(`create-${kind}-different-operations`)
      const firstOperationId = crypto.randomUUID()
      const secondOperationId = crypto.randomUUID()

      const [first, second] = await Promise.all([
        createRoomForOperation(userId, firstOperationId, kind),
        createRoomForOperation(userId, secondOperationId, kind),
      ])
      createdRoomIds.push(first.id)

      expect(second).toEqual(first)
      await expect(roomForCreationOperation(userId, firstOperationId, kind)).resolves.toEqual(first)
      await expect(roomForCreationOperation(userId, secondOperationId, kind)).resolves.toEqual(
        first,
      )
      const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
      expect(records).toEqual([{ id: first.id }])
    },
  )

  it('acquires one active room for concurrent creation kinds with different operation IDs', async () => {
    const userId = await insertUser('create-mixed-kinds-different-operations')
    const multiplayerOperationId = crypto.randomUUID()
    const singlePlayerOperationId = crypto.randomUUID()

    const [multiplayerRoom, singlePlayerRoom] = await Promise.all([
      createRoomForOperation(userId, multiplayerOperationId, 'multiplayer'),
      createRoomForOperation(userId, singlePlayerOperationId, 'single-player'),
    ])
    createdRoomIds.push(multiplayerRoom.id)

    expect(singlePlayerRoom).toEqual(multiplayerRoom)
    await expect(
      roomForCreationOperation(userId, multiplayerOperationId, 'multiplayer'),
    ).resolves.toEqual(multiplayerRoom)
    await expect(
      roomForCreationOperation(userId, singlePlayerOperationId, 'single-player'),
    ).resolves.toEqual(multiplayerRoom)
    const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
    expect(records).toEqual([{ id: multiplayerRoom.id }])
  })

  it('does not alias multiplayer and single-player creation operations', async () => {
    const userId = await insertUser('create-kind-mismatch')
    const operationId = crypto.randomUUID()
    const created = await createRoomForOperation(userId, operationId, 'multiplayer')
    createdRoomIds.push(created.id)

    await expect(
      createRoomForOperation(userId, operationId, 'single-player'),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('does not replay a creation operation after its room is deleted', async () => {
    const userId = await insertUser('create-after-delete')
    const operationId = crypto.randomUUID()
    const created = await createRoomForOperation(userId, operationId, 'single-player')
    await db.delete(room).where(eq(room.id, created.id))

    await expect(
      createRoomForOperation(userId, operationId, 'single-player'),
    ).rejects.toMatchObject({ code: 'not-found' })
    const records = await db.select({ id: room.id }).from(room).where(eq(room.hostUserId, userId))
    expect(records).toEqual([])
  })

  it('serializes create before join for the same user and keeps one active room', async () => {
    const targetHost = await insertUser('create-join-target-host')
    const actor = await insertUser('create-join-actor')
    const target = await insertLobby(targetHost)

    const [creation, joining] = await withUserLockBarrier(
      actor,
      async ({ release, waitForBlockedTransitions }) => {
        const createPending = createRoomForOperation(actor, crypto.randomUUID(), 'multiplayer')
        await waitForBlockedTransitions(1)
        const joinPending = joinRoom(actor, target.code)
        await waitForBlockedTransitions(2)
        await release()
        return Promise.allSettled([createPending, joinPending])
      },
    )

    expect(creation.status).toBe('fulfilled')
    expect(joining.status).toBe('rejected')
    if (creation.status === 'fulfilled') {
      createdRoomIds.push(creation.value.id)
      expect(await activeRoomIds(actor)).toEqual([creation.value.id])
    }
    if (joining.status === 'rejected') {
      expect(joining.reason).toMatchObject({ code: 'conflict' })
    }
  })

  it('serializes join before create and maps the creation to the joined room', async () => {
    const targetHost = await insertUser('join-create-target-host')
    const actor = await insertUser('join-create-actor')
    const target = await insertLobby(targetHost)
    const operationId = crypto.randomUUID()

    const [joining, creation] = await withUserLockBarrier(
      actor,
      async ({ release, waitForBlockedTransitions }) => {
        const joinPending = joinRoom(actor, target.code)
        await waitForBlockedTransitions(1)
        const createPending = createRoomForOperation(actor, operationId, 'multiplayer')
        await waitForBlockedTransitions(2)
        await release()
        return Promise.all([joinPending, createPending])
      },
    )

    expect(creation.id).toBe(joining.id)
    expect(joining.id).toBe(target.roomId)
    await expect(roomForCreationOperation(actor, operationId, 'multiplayer')).resolves.toEqual(
      creation,
    )
    expect(await activeRoomIds(actor)).toEqual([target.roomId])
  })

  it.each([
    ['owner', 'join', 'competing'],
    ['partner', 'join', 'competing'],
    ['owner', 'create', 'competing'],
    ['partner', 'create', 'competing'],
    ['owner', 'join', 'party'],
    ['partner', 'join', 'party'],
    ['owner', 'create', 'party'],
    ['partner', 'create', 'party'],
  ] as const)(
    'serializes party start against %s %s with %s first',
    async (role, operation, first) => {
      const owner = await insertUser(`party-race-${role}-${operation}-${first}-owner`)
      const partner = await insertUser(`party-race-${role}-${operation}-${first}-partner`)
      const targetHost = await insertUser(`party-race-${role}-${operation}-${first}-target`)
      await insertParty(owner, partner)
      const target = await insertLobby(targetHost)
      const actor = role === 'owner' ? owner : partner

      const [competing, starting] = await withUserLockBarrier(
        actor,
        async ({ release, waitForBlockedTransitions }) => {
          const compete = () => {
            return operation === 'join'
              ? joinRoom(actor, target.code)
              : createRoomForOperation(actor, crypto.randomUUID(), 'multiplayer')
          }
          const competingPending = first === 'competing' ? compete() : undefined
          const startPending = first === 'party' ? startPartyRoom(owner) : undefined
          await waitForBlockedTransitions(1)
          const secondCompeting = competingPending ?? compete()
          const secondStart = startPending ?? startPartyRoom(owner)
          await waitForBlockedTransitions(2)
          await release()
          return Promise.allSettled([secondCompeting, secondStart])
        },
      )

      if (first === 'competing') {
        expect(competing.status).toBe('fulfilled')
        expect(starting.status).toBe('rejected')
        if (competing.status === 'fulfilled') {
          if (operation === 'create') {
            createdRoomIds.push(competing.value.id)
          }
          expect(await activeRoomIds(actor)).toEqual([competing.value.id])
        }
        if (starting.status === 'rejected') {
          expect(starting.reason).toMatchObject({ code: 'conflict' })
        }
        expect((await activeRoomIds(role === 'owner' ? partner : owner)).length).toBe(0)
      } else {
        expect(starting.status).toBe('fulfilled')
        if (starting.status === 'fulfilled') {
          createdRoomIds.push(starting.value.id)
          expect(await activeRoomIds(owner)).toEqual([starting.value.id])
          expect(await activeRoomIds(partner)).toEqual([starting.value.id])
          if (operation === 'create' && competing.status === 'fulfilled') {
            expect(competing.value.id).toBe(starting.value.id)
          }
        }
        if (operation === 'join') {
          expect(competing.status).toBe('rejected')
        } else {
          expect(competing.status).toBe('fulfilled')
        }
      }
    },
  )

  it('keeps foreign-key ownership writes compatible with coordinator locks', async () => {
    const owner = await insertUser('ownership-fk-owner')
    const previousHost = await insertUser('ownership-fk-previous-host')
    const target = await insertLobby(previousHost)
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('select id from "user" where id = $1 for no key update', [owner])

      const writes = Promise.all([
        db.insert(party).values({ ownerUserId: owner }).returning({ id: party.id }),
        db.update(room).set({ hostUserId: owner }).where(eq(room.id, target.roomId)),
      ])
      const [created] = await Promise.race([
        writes,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Foreign-key key-share check blocked on the coordinator lock.'))
          }, 1_000)
        }),
      ])
      createdPartyIds.push(created[0]!.id)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })

  it('rejects party-room reuse after a party member is replaced by a bot', async () => {
    const owner = await insertUser('party-bot-replacement-owner')
    const partner = await insertUser('party-bot-replacement-partner')
    await insertParty(owner, partner)
    const started = await startPartyRoom(owner)
    createdRoomIds.push(started.id)
    await db.update(room).set({ status: 'paused' }).where(eq(room.id, started.id))
    await db.update(roomSeat).set({ connected: false }).where(eq(roomSeat.userId, partner))

    await voteForBot(owner, started.id, 2)

    await expect(startPartyRoom(owner)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('enforces one active room for direct old-writer seat inserts and deletes', async () => {
    const firstHost = await insertUser('old-writer-first-host')
    const secondHost = await insertUser('old-writer-second-host')
    const actor = await insertUser('old-writer-actor')
    const first = await insertLobby(firstHost)
    const second = await insertLobby(secondHost)

    await admin.query(
      'insert into room_seat (room_id, seat, user_id, connected) values ($1, 1, $2, true)',
      [first.roomId, actor],
    )
    await expect(
      admin.query(
        'insert into room_seat (room_id, seat, user_id, connected) values ($1, 1, $2, true)',
        [second.roomId, actor],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    await admin.query('delete from room_seat where room_id = $1 and user_id = $2', [
      first.roomId,
      actor,
    ])
    await admin.query(
      'insert into room_seat (room_id, seat, user_id, connected) values ($1, 1, $2, true)',
      [second.roomId, actor],
    )
    await expect(
      db.select().from(activeRoomMembership).where(eq(activeRoomMembership.userId, actor)),
    ).resolves.toMatchObject([{ roomId: second.roomId, userId: actor }])
  })

  it('enforces one active room for direct old-writer room status transitions', async () => {
    const firstHost = await insertUser('old-status-first-host')
    const firstPartner = await insertUser('old-status-first-partner')
    const secondHost = await insertUser('old-status-second-host')
    const firstRoom = await insertRoom({
      hostUserId: firstHost,
      partnerUserId: firstPartner,
      lastSeenAt: new Date(),
      status: 'finished',
    })
    const secondRoom = await insertRoom({
      hostUserId: secondHost,
      partnerUserId: firstPartner,
      lastSeenAt: new Date(),
      status: 'finished',
    })

    await admin.query("update room set status = 'playing' where id = $1", [firstRoom])
    await expect(
      admin.query("update room set status = 'playing' where id = $1", [secondRoom]),
    ).rejects.toMatchObject({ code: '23505' })
    await admin.query("update room set status = 'finished' where id = $1", [firstRoom])
    await admin.query("update room set status = 'playing' where id = $1", [secondRoom])

    expect(await activeRoomIds(firstPartner)).toEqual([secondRoom])
  })

  it('serializes old-writer seat inserts with room deactivation triggers', async () => {
    const host = await insertUser('old-race-host')
    const actor = await insertUser('old-race-actor')
    const target = await insertLobby(host)
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query("update room set status = 'finished' where id = $1", [target.roomId])
      let inserted = false
      const insertion = admin
        .query(
          'insert into room_seat (room_id, seat, user_id, connected) values ($1, 1, $2, true)',
          [target.roomId, actor],
        )
        .then(() => {
          inserted = true
        })

      await new Promise((resolve) => {
        setTimeout(resolve, 50)
      })
      expect(inserted).toBe(false)
      await client.query('commit')
      await insertion
    } finally {
      await client.query('rollback')
      client.release()
    }

    await expect(
      db.select().from(activeRoomMembership).where(eq(activeRoomMembership.userId, actor)),
    ).resolves.toEqual([])
  })

  it('serializes create before a party rematch and leaves the finished target inactive', async () => {
    const host = await insertUser('rematch-create-host')
    const partner = await insertUser('rematch-create-partner')
    const partyId = await insertParty(host, partner)
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const finishedRoomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
      partyId,
    })
    await admin.query('insert into rematch_vote (room_id, user_id) values ($1, $2)', [
      finishedRoomId,
      partner,
    ])

    const [creation, rematch] = await withUserLockBarrier(
      host,
      async ({ release, waitForBlockedTransitions }) => {
        const createPending = createRoomForOperation(host, crypto.randomUUID(), 'multiplayer')
        await waitForBlockedTransitions(1)
        const rematchPending = confirmRematch(host, finishedRoomId)
        await waitForBlockedTransitions(2)
        await release()
        return Promise.allSettled([createPending, rematchPending])
      },
    )

    expect(creation.status).toBe('fulfilled')
    expect(rematch.status).toBe('rejected')
    if (creation.status === 'fulfilled') {
      createdRoomIds.push(creation.value.id)
      expect(await activeRoomIds(host)).toEqual([creation.value.id])
    }
    const [finished] = await db
      .select({ status: room.status })
      .from(room)
      .where(eq(room.id, finishedRoomId))
    expect(finished.status).toBe('finished')
  })

  it('serializes a party rematch before create and maps creation to the target room', async () => {
    const host = await insertUser('rematch-first-host')
    const partner = await insertUser('rematch-first-partner')
    const partyId = await insertParty(host, partner)
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
      partyId,
    })
    await admin.query('insert into rematch_vote (room_id, user_id) values ($1, $2)', [
      roomId,
      partner,
    ])

    const [rematch, creation] = await withUserLockBarrier(
      host,
      async ({ release, waitForBlockedTransitions }) => {
        const rematchPending = confirmRematch(host, roomId)
        await waitForBlockedTransitions(1)
        const createPending = createRoomForOperation(host, crypto.randomUUID(), 'multiplayer')
        await waitForBlockedTransitions(2)
        await release()
        return Promise.all([rematchPending, createPending])
      },
    )

    expect(rematch.status).toBe('playing')
    expect(creation.id).toBe(roomId)
    expect(await activeRoomIds(host)).toEqual([roomId])
  })

  it('serializes overlapping rematches by sorted participant locks', async () => {
    const shared = await insertUser('overlapping-rematch-shared')
    const firstPartner = await insertUser('overlapping-rematch-first')
    const secondPartner = await insertUser('overlapping-rematch-second')
    const firstParty = await insertParty(shared, firstPartner)
    const secondParty = await insertOpenParty(secondPartner)
    const firstGame = createGame(createDeck(), DEFAULT_RULES)
    firstGame.phase = 'match-over'
    firstGame.score = [10, 0]
    const secondGame = createGame(createDeck(), DEFAULT_RULES)
    secondGame.phase = 'match-over'
    secondGame.score = [10, 0]
    const firstRoom = await insertRoom({
      hostUserId: shared,
      partnerUserId: firstPartner,
      lastSeenAt: new Date(),
      game: firstGame,
      status: 'finished',
      partyId: firstParty,
    })
    const secondRoom = await insertRoom({
      hostUserId: shared,
      partnerUserId: secondPartner,
      lastSeenAt: new Date(),
      game: secondGame,
      status: 'finished',
      partyId: secondParty.id,
    })
    await admin.query(
      `insert into rematch_vote (room_id, user_id)
       values ($1, $2), ($3, $4)`,
      [firstRoom, firstPartner, secondRoom, secondPartner],
    )

    const results = await withUserLockBarrier(
      shared,
      async ({ release, waitForBlockedTransitions }) => {
        const firstPending = confirmRematch(shared, firstRoom)
        await waitForBlockedTransitions(1)
        const secondPending = confirmRematch(shared, secondRoom)
        await waitForBlockedTransitions(2)
        await release()
        return Promise.allSettled([firstPending, secondPending])
      },
    )

    expect(
      results.filter(({ status }) => {
        return status === 'fulfilled'
      }),
    ).toHaveLength(1)
    expect(
      results.filter(({ status }) => {
        return status === 'rejected'
      }),
    ).toHaveLength(1)
    expect(await activeRoomIds(shared)).toHaveLength(1)
  })

  it('allows an idempotent new-match retry when the active room is the finished target', async () => {
    const host = await insertUser('finished-target-host')
    const partner = await insertUser('finished-target-partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
    })
    const command = {
      roomId,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      action: { type: 'new-match' as const },
    }

    const transitioned = await submit(host, command)
    const retried = await submit(host, command)

    expect(transitioned.status).toBe('playing')
    expect(retried).toEqual(transitioned)
    expect(await activeRoomIds(host)).toEqual([roomId])
  })

  it('returns the recorded party for a sequential same-invite retry', async () => {
    const owner = await insertUser('owner')
    const joiningUser = await insertUser('joining-user')
    const openParty = await insertOpenParty(owner)

    const joined = await joinParty(joiningUser, openParty.inviteCode)
    const retried = await joinParty(joiningUser, openParty.inviteCode)

    expect(joined.id).toBe(openParty.id)
    expect(retried).toEqual(joined)
    await expect(
      db
        .select({ partyId: partyJoin.partyId })
        .from(partyJoin)
        .where(eq(partyJoin.userId, joiningUser)),
    ).resolves.toEqual([{ partyId: openParty.id }])
  })

  it('converges overlapping same-invite joins after waiting on the party lock', async () => {
    const owner = await insertUser('owner')
    const joiningUser = await insertUser('joining-user')
    const openParty = await insertOpenParty(owner)

    const [first, second] = await withPartyLockBarrier(
      openParty.id,
      async ({ release, waitForBlockedJoins }) => {
        const firstJoin = joinParty(joiningUser, openParty.inviteCode)
        await waitForBlockedJoins(1)
        const secondJoin = joinParty(joiningUser, openParty.inviteCode)
        await waitForBlockedJoins(2)
        await release()
        return Promise.all([firstJoin, secondJoin])
      },
    )

    expect(first.id).toBe(openParty.id)
    expect(second).toEqual(first)
  })

  it('returns the recorded party for a same-code retry from a new runtime', async () => {
    const owner = await insertUser('owner')
    const joiningUser = await insertUser('joining-user')
    const openParty = await insertOpenParty(owner)
    const joined = await joinParty(joiningUser, openParty.inviteCode)
    const reloadedRuntime = createGameRuntime(db)

    try {
      const retried = await reloadedRuntime.runPromise(
        Effect.flatMap(GameService, (games) => {
          return games.joinParty(joiningUser, openParty.inviteCode)
        }),
      )
      expect(retried).toEqual(joined)
    } finally {
      await reloadedRuntime.dispose()
    }
  })

  it('rejects an unrelated cross-party invite for an existing member', async () => {
    const firstOwner = await insertUser('first-owner')
    const secondOwner = await insertUser('second-owner')
    const joiningUser = await insertUser('joining-user')
    const firstParty = await insertOpenParty(firstOwner)
    const secondParty = await insertOpenParty(secondOwner)

    await joinParty(joiningUser, firstParty.inviteCode)

    await expect(joinParty(joiningUser, secondParty.inviteCode)).rejects.toMatchObject({
      code: 'conflict',
    })
    const memberships = await db
      .select({ partyId: partyMember.partyId })
      .from(partyMember)
      .where(eq(partyMember.userId, joiningUser))
    expect(memberships).toEqual([{ partyId: firstParty.id }])
  })

  it('loads and projects a room in one statement without leaking private game state', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
    })

    const { result: view, queries: statements } = await capturedQueries(() => {
      return getRoom(host, roomId)
    })

    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^select /i)
    expect(statements[0]).not.toMatch(/for update/i)
    expect(statements[0].match(/jsonb_agg/g)).toHaveLength(4)
    expect(statements[0]).toMatch(/limit 4/i)
    expect(statements[0]).toMatch(/limit 8/i)
    expect(statements[0]).toMatch(/limit 12/i)
    expect(statements[0]).not.toMatch(/left join "disconnect_vote"/i)
    expect(statements[0]).not.toMatch(/left join "rematch_vote"/i)
    expect(view.game?.hand).toEqual(game.hands[0])
    expect(view.game).not.toHaveProperty('hands')
    expect(view.game).not.toHaveProperty('kitty')
    expect(view.game).not.toHaveProperty('initialHands')
    expect(view.game).not.toHaveProperty('ratingParticipants')
    expect(view.seats).toHaveLength(4)
  })

  it('uses one lock-free select for a stable repeatable-read idle tick', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
    })

    const { queries: statements } = await capturedQueries(() => {
      return tick(host, roomId)
    })

    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^select /i)
    expect(statements[0]).not.toMatch(/for update/i)
  })

  it('loads the latest current room in one statement without truncating seats', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      updatedAt: new Date(Date.now() + 1_000),
    })

    const { result: view, queries: statements } = await capturedQueries(() => {
      return currentRoom(host)
    })

    expect(statements).toHaveLength(1)
    expect(view?.id).toBe(roomId)
    expect(view?.seats).toHaveLength(4)
  })

  it('prefers authoritative active membership over an old Worker finished timestamp', async () => {
    const host = await insertUser('current-active-host')
    const partner = await insertUser('current-active-partner')
    const activeRoomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    const finishedRoomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'finished',
      updatedAt: new Date(Date.now() - 60_000),
    })

    await admin.query("update room set updated_at = now() + interval '1 hour' where id = $1", [
      finishedRoomId,
    ])

    await expect(currentRoom(host)).resolves.toMatchObject({ id: activeRoomId, status: 'playing' })
  })

  it('falls back to the latest finished historical room when no active membership exists', async () => {
    const host = await insertUser('current-history-host')
    const partner = await insertUser('current-history-partner')
    const olderRoomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'finished',
      updatedAt: new Date(Date.now() - 60_000),
    })
    const latestRoomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'finished',
      updatedAt: new Date(),
    })

    expect(olderRoomId).not.toBe(latestRoomId)
    await expect(currentRoom(host)).resolves.toMatchObject({ id: latestRoomId, status: 'finished' })
  })

  it('locks the room, then loads children, inserts, and updates for a normal command', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'playing'
    game.activePlayer = 0
    game.trump = 'clubs'
    game.maker = 0
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
    })
    const command = {
      roomId,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      action: { type: 'play' as const, cardId: game.hands[0][0].id },
    }

    const { result: view, queries: statements } = await capturedQueries(() => {
      return submit(host, command)
    })

    expect(statements).toHaveLength(4)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(2)
    expect(
      statements.filter((statement) => {
        return /^insert /i.test(statement)
      }),
    ).toHaveLength(1)
    expect(
      statements.filter((statement) => {
        return /^update /i.test(statement)
      }),
    ).toHaveLength(1)
    expect(statements[0]).toMatch(/for update of "room"/i)
    expect(statements[1]).toMatch(/jsonb_agg/i)
    expect(statements[1]).not.toMatch(/"room"\."game"/i)
    expect(view.version).toBe(2)

    const duplicate = await capturedQueries(() => {
      return submit(host, command)
    })
    expect(duplicate.queries).toHaveLength(2)
    expect(duplicate.result.version).toBe(2)
  })

  it('uses the locked snapshot and known writes for a replacement vote', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'paused',
    })
    await db.update(roomSeat).set({ connected: false }).where(eq(roomSeat.userId, partner))

    const { result: view, queries: statements } = await capturedQueries(() => {
      return voteForBot(host, roomId, 2)
    })

    expect(statements).toHaveLength(6)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(2)
    expect(statements[0]).toMatch(/for update of "room"/i)
    expect(view.seats[2].controller).toBe('bot')
    expect(view.disconnectVote).toBeNull()
  })

  it('uses the locked snapshot for a rematch confirmation', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const partyId = await insertParty(host, partner)
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
      partyId,
    })

    const { result: view, queries: statements } = await capturedQueries(() => {
      return confirmRematch(host, roomId)
    })

    expect(statements).toHaveLength(6)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(4)
    expect(statements[1]).toMatch(/for no key update of "user"/i)
    expect(statements[2]).toMatch(/for update of "room"/i)
    expect(view.rematch?.confirmations).toEqual([0])
  })

  it('keeps a recorded rematch vote idempotent when no transition is needed', async () => {
    const host = await insertUser('idempotent-rematch-host')
    const partner = await insertUser('idempotent-rematch-partner')
    const partyId = await insertParty(host, partner)
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
      partyId,
    })

    const first = await confirmRematch(host, roomId)
    const active = await createRoomForOperation(host, crypto.randomUUID(), 'multiplayer')
    createdRoomIds.push(active.id)
    const retried = await confirmRematch(host, roomId)

    expect(retried).toEqual(first)
    expect(await activeRoomIds(host)).toEqual([active.id])
  })

  it('uses the locked snapshot for presence without bumping the game version', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
    })

    const { result: view, queries: statements } = await capturedQueries(() => {
      return setPresence(partner, roomId, false)
    })

    expect(statements).toHaveLength(5)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(3)
    expect(statements[1]).toMatch(/for update of "room"/i)
    expect(view.version).toBe(1)
    expect(view.seats[2].connected).toBe(false)
  })

  it('sees a duplicate command that commits while the retry waits for the room lock', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'playing'
    game.activePlayer = 0
    game.trump = 'clubs'
    game.maker = 0
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
    })
    const command = {
      roomId,
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      action: { type: 'play' as const, cardId: game.hands[0][0].id },
    }

    await withRoomLockBarrier(roomId, async ({ client, release, waitForBlockedMutation }) => {
      await client.query('update room set version = 2 where id = $1', [roomId])
      await client.query(
        `insert into room_command (room_id, command_id, user_id, action)
           values ($1, $2, $3, $4::jsonb)`,
        [roomId, command.commandId, host, JSON.stringify(command.action)],
      )
      const pending = submit(host, command)
      await waitForBlockedMutation()
      await release(true)
      const view = await pending
      expect(view.version).toBe(2)
    })

    const duplicateCount = await admin.query<{ count: string }>(
      'select count(*) from room_command where room_id = $1 and command_id = $2',
      [roomId, command.commandId],
    )
    expect(duplicateCount.rows[0]?.count).toBe('1')
  })

  it('sees the penultimate bot vote when it commits before the final vote evaluates', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const finalVoter = await insertUser('final-voter')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'paused',
    })
    await admin.query(
      `update room_seat
       set user_id = $2, connected = true, controller = 'human'
       where room_id = $1 and seat = 1`,
      [roomId, finalVoter],
    )
    await admin.query(
      `update room_seat
       set connected = false, controller = 'human'
       where room_id = $1 and seat = 2`,
      [roomId],
    )

    await withRoomLockBarrier(roomId, async ({ client, release, waitForBlockedMutation }) => {
      await client.query(
        `insert into disconnect_vote (
             room_id, disconnected_seat, voter_user_id, approve_bot
           ) values ($1, 2, $2, true)`,
        [roomId, host],
      )
      const pending = voteForBot(finalVoter, roomId, 2)
      await waitForBlockedMutation()
      await release(true)
      const view = await pending
      expect(view.seats[2].controller).toBe('bot')
      expect(view.disconnectVote).toBeNull()
    })
  })

  it('sees the first rematch confirmation when it commits before the final confirmation evaluates', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const partyId = await insertParty(host, partner)
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'match-over'
    game.score = [10, 0]
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      status: 'finished',
      partyId,
    })

    const [first, final] = await withUserLockBarrier(
      host,
      async ({ release, waitForBlockedTransitions }) => {
        const firstPending = confirmRematch(host, roomId)
        await waitForBlockedTransitions(1)
        const finalPending = confirmRematch(partner, roomId)
        await waitForBlockedTransitions(2)
        await release()
        return Promise.all([firstPending, finalPending])
      },
    )

    expect(first.rematch?.confirmations).toEqual([0])
    expect(final.game?.phase).not.toBe('match-over')
    expect(final.rematch).toBeNull()
    expect(final.version).toBe(3)
  })

  it('keeps a truly stale seat connected when its heartbeat commits before stale evaluation', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const staleAt = new Date(Date.now() - 16_000)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: staleAt,
      partnerLastSeenAt: new Date(),
    })

    await withRoomLockBarrier(roomId, async ({ client, release, waitForBlockedMutation }) => {
      await client.query(
        `update room_seat
           set connected = true, controller = 'human', last_seen_at = now()
           where room_id = $1 and user_id = $2`,
        [roomId, host],
      )
      const pending = tick(partner, roomId)
      await waitForBlockedMutation()
      await release(true)
      await pending
    })

    const hostSeat = await seatSnapshot(roomId, host)
    expect(hostSeat.connected).toBe(true)
    expect(hostSeat.controller).toBe('human')
    expect(hostSeat.lastSeenAt).toBeGreaterThan(staleAt.getTime())
  })

  it('stable fresh heartbeat does not take the room lock or mutate the seat', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const lastSeenAt = new Date(Date.now() - 1_000)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt,
    })
    const before = await seatSnapshot(roomId, host)

    await withRoomLockBarrier(roomId, async () => {
      const result = await Promise.race([
        tick(host, roomId).then((view) => {
          return { kind: 'resolved' as const, view }
        }),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          setTimeout(() => {
            resolve({ kind: 'timeout' })
          }, 1_000)
        }),
      ])
      expect(result.kind).toBe('resolved')
      if (result.kind === 'resolved') {
        for (const seat of result.view.seats) {
          expect(Object.keys(seat).sort()).toEqual(
            [
              'connected',
              'controller',
              'name',
              'rating',
              'ratingGames',
              'ratingMode',
              'seat',
              'userId',
            ].sort(),
          )
        }
      }
    })

    const after = await seatSnapshot(roomId, host)
    expect(after).toEqual(before)
  })

  it('due heartbeat waits on the room lock and advances lastSeenAt once', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const lastSeenAt = new Date(Date.now() - 6_000)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt,
    })
    const before = await seatSnapshot(roomId, host)

    await withRoomLockBarrier(roomId, async ({ release }) => {
      let settled = false
      const pending = tick(host, roomId).then((view) => {
        settled = true
        return view
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 100)
      })
      expect(settled).toBe(false)
      await release()
      await pending
    })

    const after = await seatSnapshot(roomId, host)
    expect(after.connected).toBe(true)
    expect(after.controller).toBe('human')
    expect(after.lastSeenAt).toBeGreaterThan(before.lastSeenAt)
  })

  it('serializes heartbeat before stale evaluation so a fresh seat stays connected', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const now = Date.now()
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(now - 6_000),
      partnerLastSeenAt: new Date(now - 16_000),
    })

    await tick(host, roomId)
    await tick(partner, roomId)

    const hostSeat = await seatSnapshot(roomId, host)
    expect(hostSeat.connected).toBe(true)
    expect(hostSeat.controller).toBe('human')
    expect(hostSeat.lastSeenAt).toBeGreaterThan(now - 6_000)
  })

  it('serializes stale evaluation before heartbeat so a stale seat disconnects then reconnects', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const now = Date.now()
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(now - 16_000),
      partnerLastSeenAt: new Date(now - 1_000),
    })

    await tick(partner, roomId)
    const afterStale = await seatSnapshot(roomId, host)
    expect(afterStale.connected).toBe(false)

    await tick(host, roomId)
    const afterReconnect = await seatSnapshot(roomId, host)
    expect(afterReconnect.connected).toBe(true)
    expect(afterReconnect.controller).toBe('human')
    expect(afterReconnect.lastSeenAt).toBeGreaterThan(now - 16_000)
  })

  it('concurrent heartbeat and stale ticks leave the heartbeating seat connected and fresh', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const now = Date.now()
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(now - 6_000),
      partnerLastSeenAt: new Date(now - 16_000),
    })

    await Promise.all([tick(host, roomId), tick(partner, roomId)])

    const hostSeat = await seatSnapshot(roomId, host)
    expect(hostSeat.connected).toBe(true)
    expect(hostSeat.controller).toBe('human')
    expect(hostSeat.lastSeenAt).toBeGreaterThan(now - 6_000)
  })

  it('racing bot ticks advance room version exactly once', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'playing'
    game.activePlayer = 1
    game.trump = 'clubs'
    game.maker = 1
    const updatedAt = new Date(Date.now() - 1_000)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      updatedAt,
    })
    const [before] = await db
      .select({ version: room.version })
      .from(room)
      .where(eq(room.id, roomId))

    await Promise.all([tick(host, roomId), tick(partner, roomId)])

    const [after] = await db
      .select({ version: room.version, game: room.game })
      .from(room)
      .where(eq(room.id, roomId))
    expect(after.version).toBe(before.version + 1)
    expect(after.game?.activePlayer).toBe(2)
  })

  it('repairs paused status when all humans are connected', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      status: 'paused',
    })

    await tick(host, roomId)

    const [after] = await db.select({ status: room.status }).from(room).where(eq(room.id, roomId))
    expect(after.status).toBe('playing')
  })

  it('racing trick-collection ticks advance room version exactly once', async () => {
    const host = await insertUser('host')
    const partner = await insertUser('partner')
    const game = createGame(createDeck(), DEFAULT_RULES)
    game.phase = 'trick-complete'
    game.trump = 'clubs'
    game.maker = 0
    game.trick = [
      { player: 0, card: game.hands[0][0] },
      { player: 1, card: game.hands[1][0] },
      { player: 2, card: game.hands[2][0] },
      { player: 3, card: game.hands[3][0] },
    ]
    game.hands = [
      game.hands[0].slice(1),
      game.hands[1].slice(1),
      game.hands[2].slice(1),
      game.hands[3].slice(1),
    ]
    const updatedAt = new Date(Date.now() - 2_000)
    const roomId = await insertRoom({
      hostUserId: host,
      partnerUserId: partner,
      lastSeenAt: new Date(),
      game,
      updatedAt,
    })
    const [before] = await db
      .select({ version: room.version })
      .from(room)
      .where(eq(room.id, roomId))

    await Promise.all([tick(host, roomId), tick(partner, roomId)])

    const [after] = await db
      .select({ version: room.version, game: room.game })
      .from(room)
      .where(eq(room.id, roomId))
    expect(after.version).toBe(before.version + 1)
    expect(after.game?.phase).not.toBe('trick-complete')
  })
})
