import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { room, roomSeat, user } from '../db/schema'
import { DEFAULT_RULES } from '../game/rules'
import { createGame } from '../game/deal'
import { createDeck } from '../game/card'
import { GameService, gameRuntime } from './game-service.server'
import { Effect } from 'effect'

const runIntegration = process.env.RUN_DB_INTEGRATION === '1'

const describeIntegration = runIntegration ? describe : describe.skip

function uniqueId(label: string) {
  return `tick-int-${label}-${crypto.randomUUID()}`
}

describeIntegration('GameService.tick lock and race behavior', () => {
  const admin = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
  })
  const db = drizzle({ client: admin })
  const createdUserIds: string[] = []
  const createdRoomIds: string[] = []

  afterEach(async () => {
    for (const roomId of createdRoomIds.splice(0)) {
      await admin.query('delete from room where id = $1', [roomId])
    }
    for (const userId of createdUserIds.splice(0)) {
      await admin.query('delete from "user" where id = $1', [userId])
    }
  })

  afterAll(async () => {
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
  }) {
    const roomId = crypto.randomUUID()
    createdRoomIds.push(roomId)
    const updatedAt = options.updatedAt ?? new Date()
    await db.insert(room).values({
      id: roomId,
      code: uniqueId('code').slice(0, 6).toUpperCase(),
      hostUserId: options.hostUserId,
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

  async function withRoomLockBarrier<T>(
    roomId: string,
    work: (hold: { release: () => Promise<void> }) => Promise<T>,
  ) {
    const client = await admin.connect()
    try {
      await client.query('begin')
      await client.query('select id from room where id = $1 for update', [roomId])
      let released = false
      const release = async () => {
        if (released) {
          return
        }
        released = true
        await client.query('rollback')
      }
      try {
        return await work({ release })
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
