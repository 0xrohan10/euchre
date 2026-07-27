import { and, desc, eq } from 'drizzle-orm'
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'
import { db } from '../db/index.server'
import { disconnectVote, room, roomCommand, roomSeat, user } from '../db/schema'
import { chooseBotAction, createGame, DEFAULT_RULES, reduceGame, type GameAction, type GameState, type Player } from '../game'
import { acceptsRoomAction, eligibleBotVoters, projectGame, statusForGame, statusForPresence, type PlayerAction, type RoomView, type SeatView } from '../multiplayer'

export class GameServiceError extends Data.TaggedError('GameServiceError')<{
  readonly code: 'not-found' | 'forbidden' | 'conflict' | 'invalid' | 'database'
  readonly message: string
}> {}

type SubmitCommand = {
  roomId: string
  commandId: string
  expectedVersion: number
  action: PlayerAction | { type: 'next-hand' } | { type: 'new-match' }
}

type GameServiceShape = {
  createRoom: (userId: string) => Effect.Effect<RoomView, GameServiceError>
  currentRoom: (userId: string) => Effect.Effect<RoomView | null, GameServiceError>
  joinRoom: (userId: string, code: string) => Effect.Effect<RoomView, GameServiceError>
  getRoom: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
  submit: (userId: string, command: SubmitCommand) => Effect.Effect<RoomView, GameServiceError>
  voteForBot: (userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => Effect.Effect<RoomView, GameServiceError>
  setPresence: (userId: string, roomId: string, connected: boolean) => Effect.Effect<RoomView, GameServiceError>
  tick: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
}

export class GameService extends Context.Service<GameService, GameServiceShape>()('@kitty/GameService') {}

class DomainError extends Error {
  readonly code: GameServiceError['code']

  constructor(code: GameServiceError['code'], message: string) {
    super(message)
    this.code = code
  }
}

function failure(cause: unknown): GameServiceError {
  return cause instanceof DomainError
    ? new GameServiceError({ code: cause.code, message: cause.message })
    : new GameServiceError({ code: 'database', message: 'The game service is unavailable.' })
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => alphabet[value % alphabet.length]).join('')
}

function automate(game: GameState, seats: readonly { seat: number; controller: 'human' | 'bot' }[]): GameState {
  let current = game
  for (let step = 0; step < 64; step += 1) {
    if (current.phase === 'trick-complete') return current
    const active = seats.find(({ seat }) => seat === current.activePlayer)
    if (active?.controller !== 'bot') return current
    const action = chooseBotAction(current)
    if (!action) return current
    current = reduceGame(current, action)
  }
  throw new DomainError('invalid', 'Automatic play did not settle.')
}

async function viewRoom(userId: string, roomId: string): Promise<RoomView> {
  const [record] = await db.select().from(room).where(eq(room.id, roomId)).limit(1)
  if (!record) throw new DomainError('not-found', 'Table not found.')

  const seatRows = await db.select({
    seat: roomSeat.seat,
    userId: roomSeat.userId,
    name: user.name,
    controller: roomSeat.controller,
    connected: roomSeat.connected,
  }).from(roomSeat).innerJoin(user, eq(roomSeat.userId, user.id)).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
  const viewer = seatRows.find((seat) => seat.userId === userId)
  if (!viewer) throw new DomainError('forbidden', 'You are not seated at this table.')

  const votes = await db.select({
    disconnectedSeat: disconnectVote.disconnectedSeat,
    voterUserId: disconnectVote.voterUserId,
    approveBot: disconnectVote.approveBot,
  }).from(disconnectVote).where(eq(disconnectVote.roomId, roomId))
  const disconnectedSeat = record.status === 'paused'
    ? votes[0]?.disconnectedSeat ?? seatRows.find((seat) => !seat.connected && seat.controller === 'human')?.seat
    : undefined
  const eligibleVoters = disconnectedSeat === undefined ? [] : eligibleBotVoters(seatRows as SeatView[], disconnectedSeat as Player)
  return {
    id: record.id,
    code: record.code,
    status: record.status,
    version: record.version,
    hostUserId: record.hostUserId,
    viewerSeat: viewer.seat as Player,
    rules: record.rules,
    seats: seatRows as SeatView[],
    game: record.game ? projectGame(record.game, viewer.seat as Player) : null,
    disconnectVote: disconnectedSeat === undefined ? null : {
      disconnectedSeat: disconnectedSeat as Player,
      approvals: votes.filter((vote) => vote.approveBot && eligibleVoters.some((seat) => seat.userId === vote.voterUserId)).flatMap((vote) => {
        const voter = seatRows.find((seat) => seat.userId === vote.voterUserId)
        return voter ? [voter.seat as Player] : []
      }),
      requiredApprovals: eligibleVoters.length,
    },
  }
}

const GameServiceLive = Layer.succeed(GameService, GameService.of({
  tick: Effect.fn('GameService.tick')((userId: string, roomId: string) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, roomId)).for('update').limit(1)
        if (!record) throw new DomainError('not-found', 'Table not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
        const caller = seats.find((seat) => seat.userId === userId)
        if (!caller) throw new DomainError('forbidden', 'You are not seated at this table.')
        const callerReconnected = !caller.connected || caller.controller !== 'human'
        const now = new Date()
        await tx.update(roomSeat).set({ connected: true, controller: 'human', lastSeenAt: now }).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
        if (callerReconnected) await tx.delete(disconnectVote).where(and(eq(disconnectVote.roomId, roomId), eq(disconnectVote.disconnectedSeat, caller.seat)))
        const renewedSeats = seats.map((seat) => seat.userId === userId ? { ...seat, connected: true, controller: 'human' as const, lastSeenAt: now } : seat)
        const staleSeats = renewedSeats.filter((seat) => seat.userId !== userId && seat.connected && seat.controller === 'human' && now.getTime() - seat.lastSeenAt.getTime() >= 15_000)
        if (staleSeats.length > 0) {
          for (const seat of staleSeats) {
            await tx.update(roomSeat).set({ connected: false }).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.seat, seat.seat)))
          }
        }
        const currentSeats = renewedSeats.map((seat) => staleSeats.some((stale) => stale.seat === seat.seat) ? { ...seat, connected: false } : seat)
        const hasDisconnectedHuman = currentSeats.some((seat) => !seat.connected && seat.controller === 'human')
        const hostDisconnected = currentSeats.some((seat) => seat.userId === record.hostUserId && !seat.connected && seat.controller === 'human')
        const status = statusForPresence(record.status, record.game?.phase ?? null, hasDisconnectedHuman, hostDisconnected)
        let version = record.version
        if (callerReconnected || staleSeats.length > 0 || status !== record.status) {
          version += 1
          await tx.update(room).set({ status, version, updatedAt: now }).where(eq(room.id, roomId))
        }
        if (staleSeats.length > 0) return
        if (!record.game) return
        if (status !== 'playing' || record.game.phase !== 'trick-complete' || now.getTime() - record.updatedAt.getTime() < 1_600) return
        const game = automate(reduceGame(record.game, { type: 'collect-trick' }), currentSeats)
        await tx.update(room).set({ game, status: statusForGame(game), version: version + 1, updatedAt: now }).where(eq(room.id, roomId))
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
  currentRoom: Effect.fn('GameService.currentRoom')((userId: string) => Effect.tryPromise({
    try: async () => {
      const [seat] = await db.select({ roomId: roomSeat.roomId }).from(roomSeat)
        .innerJoin(room, eq(roomSeat.roomId, room.id))
        .where(eq(roomSeat.userId, userId)).orderBy(desc(room.updatedAt)).limit(1)
      return seat ? viewRoom(userId, seat.roomId) : null
    },
    catch: failure,
  })),
  createRoom: Effect.fn('GameService.createRoom')((userId: string) => Effect.tryPromise({
    try: async () => {
      const roomId = await db.transaction(async (tx) => {
        const [created] = await tx.insert(room).values({ code: randomCode(), hostUserId: userId, rules: DEFAULT_RULES }).returning()
        await tx.insert(roomSeat).values({ roomId: created.id, seat: 0, userId, connected: true })
        return created.id
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
  joinRoom: Effect.fn('GameService.joinRoom')((userId: string, code: string) => Effect.tryPromise({
    try: async () => {
      const roomId = await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.code, code.toUpperCase())).for('update').limit(1)
        if (!record) throw new DomainError('not-found', 'Invite code not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, record.id)).orderBy(roomSeat.seat)
        const existing = seats.find((seat) => seat.userId === userId)
        if (existing) return record.id
        if (record.status !== 'lobby' || seats.length >= 4) throw new DomainError('conflict', 'This table is already full.')
        await tx.insert(roomSeat).values({ roomId: record.id, seat: seats.length, userId, connected: true })
        if (seats.length === 3) {
          await tx.update(room).set({ status: 'playing', game: createGame(undefined, record.rules), version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, record.id))
        } else {
          await tx.update(room).set({ version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, record.id))
        }
        return record.id
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
  getRoom: Effect.fn('GameService.getRoom')((userId: string, roomId: string) => Effect.tryPromise({
    try: () => viewRoom(userId, roomId),
    catch: failure,
  })),
  submit: Effect.fn('GameService.submit')((userId: string, command: SubmitCommand) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, command.roomId)).for('update').limit(1)
        if (!record?.game) throw new DomainError('not-found', 'Active game not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, command.roomId)).orderBy(roomSeat.seat)
        const actor = seats.find((seat) => seat.userId === userId)
        if (!actor) throw new DomainError('forbidden', 'You are not seated at this table.')
        const [duplicate] = await tx.select().from(roomCommand).where(and(eq(roomCommand.roomId, command.roomId), eq(roomCommand.commandId, command.commandId))).limit(1)
        if (duplicate) return
        if (!acceptsRoomAction(record.status, record.game.phase, command.action.type)) throw new DomainError('conflict', 'That action is not available in the current game state.')
        if (record.version !== command.expectedVersion) throw new DomainError('conflict', 'Your game view is stale.')
        if (actor.controller !== 'human') throw new DomainError('forbidden', 'This seat is currently controlled by a bot.')
        const hostAction = command.action.type === 'next-hand' || command.action.type === 'new-match'
        if (hostAction && record.hostUserId !== userId) throw new DomainError('forbidden', 'Only the host can advance the match.')
        if (!hostAction && record.game.activePlayer !== actor.seat) throw new DomainError('forbidden', 'It is not your turn.')
        const reduced = reduceGame(record.game, command.action as GameAction)
        if (reduced === record.game) throw new DomainError('invalid', 'That action is not legal now.')
        const game = automate(reduced, seats)
        const hasDisconnectedHuman = seats.some((seat) => !seat.connected && seat.controller === 'human')
        const hostDisconnected = seats.some((seat) => seat.userId === record.hostUserId && !seat.connected && seat.controller === 'human')
        const status = statusForPresence(statusForGame(game), game.phase, hasDisconnectedHuman, hostDisconnected)
        await tx.insert(roomCommand).values({ roomId: command.roomId, commandId: command.commandId, userId, action: command.action as GameAction })
        await tx.update(room).set({ game, status, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, command.roomId))
      })
      return viewRoom(userId, command.roomId)
    },
    catch: failure,
  })),
  voteForBot: Effect.fn('GameService.voteForBot')((userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, roomId)).for('update').limit(1)
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
        const voter = seats.find((seat) => seat.userId === userId)
        const disconnected = seats.find((seat) => seat.seat === disconnectedSeat && !seat.connected && seat.controller === 'human')
        if (!record?.game || record.status !== 'paused' || !voter || !disconnected || voter.seat === disconnected.seat || !voter.connected || voter.controller !== 'human') throw new DomainError('invalid', 'There is no active replacement vote.')
        const eligibleVoters = eligibleBotVoters(seats, disconnected.seat as Player)
        const [previousVote] = await tx.select().from(disconnectVote).where(and(eq(disconnectVote.roomId, roomId), eq(disconnectVote.disconnectedSeat, disconnected.seat), eq(disconnectVote.voterUserId, userId))).limit(1)
        await tx.insert(disconnectVote).values({ roomId, disconnectedSeat: disconnected.seat, voterUserId: userId, approveBot: approve }).onConflictDoUpdate({
          target: [disconnectVote.roomId, disconnectVote.disconnectedSeat, disconnectVote.voterUserId],
          set: { approveBot: approve, createdAt: new Date() },
        })
        const votes = await tx.select().from(disconnectVote).where(and(eq(disconnectVote.roomId, roomId), eq(disconnectVote.disconnectedSeat, disconnected.seat)))
        if (eligibleVoters.length > 0 && eligibleVoters.every((seat) => votes.some((vote) => vote.voterUserId === seat.userId && vote.approveBot))) {
          await tx.update(roomSeat).set({ controller: 'bot' }).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.seat, disconnected.seat)))
          const controlledSeats = seats.map((seat) => seat.seat === disconnected.seat ? { ...seat, controller: 'bot' as const } : seat)
          const game = automate(record.game, controlledSeats)
          const status = controlledSeats.some((seat) => !seat.connected && seat.controller === 'human') ? 'paused' : statusForGame(game)
          const hostUserId = disconnected.userId === record.hostUserId ? eligibleVoters[0]?.userId ?? record.hostUserId : record.hostUserId
          await tx.update(room).set({ status, hostUserId, game, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
          await tx.delete(disconnectVote).where(eq(disconnectVote.roomId, roomId))
        } else if (!previousVote || previousVote.approveBot !== approve) {
          await tx.update(room).set({ version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
        }
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
  setPresence: Effect.fn('GameService.setPresence')((userId: string, roomId: string, connected: boolean) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, roomId)).for('update').limit(1)
        const [seat] = await tx.select().from(roomSeat).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId))).limit(1)
        if (!record || !seat) throw new DomainError('forbidden', 'You are not seated at this table.')
        const presenceChanged = seat.connected !== connected || (connected && seat.controller !== 'human')
        await tx.update(roomSeat).set({ connected, controller: connected ? 'human' : seat.controller, lastSeenAt: new Date() }).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
        if (connected) {
          await tx.delete(disconnectVote).where(and(eq(disconnectVote.roomId, roomId), eq(disconnectVote.disconnectedSeat, seat.seat)))
        }
        const disconnectedSeats = await tx.select().from(roomSeat).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.connected, false)))
        const hasDisconnectedHuman = disconnectedSeats.some((other) => other.controller === 'human')
        const hostDisconnected = disconnectedSeats.some((other) => other.userId === record.hostUserId && other.controller === 'human')
        const status = statusForPresence(record.status, record.game?.phase ?? null, hasDisconnectedHuman, hostDisconnected)
        if (presenceChanged || status !== record.status) {
          await tx.update(room).set({ status, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
        }
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
}))

export const gameRuntime = ManagedRuntime.make(GameServiceLive)
