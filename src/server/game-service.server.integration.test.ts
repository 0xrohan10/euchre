import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { party, partyMember, room, roomSeat, user } from '../db/schema'
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
    max: 4,
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
      code: uniqueId('code').slice(0, 6).toUpperCase(),
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

  async function insertParty(ownerUserId: string, partnerUserId: string) {
    const [created] = await db.insert(party).values({ ownerUserId }).returning({ id: party.id })
    createdPartyIds.push(created.id)
    await db.insert(partyMember).values([
      { partyId: created.id, userId: ownerUserId },
      { partyId: created.id, userId: partnerUserId },
    ])
    return created.id
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

    expect(statements).toHaveLength(4)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(2)
    expect(statements[0]).toMatch(/for update of "room"/i)
    expect(view.rematch?.confirmations).toEqual([0])
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

    expect(statements).toHaveLength(4)
    expect(
      statements.filter((statement) => {
        return /^select /i.test(statement)
      }),
    ).toHaveLength(2)
    expect(statements[0]).toMatch(/for update of "room"/i)
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

    await withRoomLockBarrier(roomId, async ({ client, release, waitForBlockedMutation }) => {
      await client.query('insert into rematch_vote (room_id, user_id) values ($1, $2)', [
        roomId,
        host,
      ])
      const pending = confirmRematch(partner, roomId)
      await waitForBlockedMutation()
      await release(true)
      const view = await pending
      expect(view.game?.phase).not.toBe('match-over')
      expect(view.rematch).toBeNull()
      expect(view.version).toBe(2)
    })
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
