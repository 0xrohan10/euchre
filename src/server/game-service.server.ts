import { and, desc, eq, inArray } from 'drizzle-orm'
import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect'
import { db } from '../db/index.server'
import { disconnectVote, party, partyMember, rematchVote, room, roomCommand, roomSeat, user } from '../db/schema'
import { createGame, reduceGame, type GameAction, type GameRules, type Player } from '../game'
import { acceptsRoomAction, advanceBot, eligibleBotVoters, projectGame, statusForGame, statusForPresence, type PartyView, type PlayerAction, type RoomView, type SeatView } from '../multiplayer'

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
  createRoom: (userId: string, rules: GameRules) => Effect.Effect<RoomView, GameServiceError>
  createSinglePlayerRoom: (userId: string, rules: GameRules) => Effect.Effect<RoomView, GameServiceError>
  currentParty: (userId: string) => Effect.Effect<PartyView | null, GameServiceError>
  createParty: (userId: string) => Effect.Effect<PartyView, GameServiceError>
  joinParty: (userId: string, inviteCode: string) => Effect.Effect<PartyView, GameServiceError>
  leaveParty: (userId: string) => Effect.Effect<void, GameServiceError>
  startPartyRoom: (userId: string, rules: GameRules) => Effect.Effect<RoomView, GameServiceError>
  currentRoom: (userId: string) => Effect.Effect<RoomView | null, GameServiceError>
  joinRoom: (userId: string, code: string) => Effect.Effect<RoomView, GameServiceError>
  leaveRoom: (userId: string, roomId: string) => Effect.Effect<void, GameServiceError>
  getRoom: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
  submit: (userId: string, command: SubmitCommand) => Effect.Effect<RoomView, GameServiceError>
  voteForBot: (userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => Effect.Effect<RoomView, GameServiceError>
  confirmRematch: (userId: string, roomId: string) => Effect.Effect<RoomView, GameServiceError>
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

type RoomReader = Pick<typeof db, 'select'>

async function viewParty(userId: string, database: RoomReader = db): Promise<PartyView | null> {
  const [membership] = await database.select({ partyId: partyMember.partyId }).from(partyMember).where(eq(partyMember.userId, userId)).limit(1)
  if (!membership) return null
  const [record] = await database.select().from(party).where(eq(party.id, membership.partyId)).limit(1)
  if (!record) return null
  const members = await database.select({ userId: partyMember.userId, name: user.name }).from(partyMember)
    .innerJoin(user, eq(partyMember.userId, user.id)).where(eq(partyMember.partyId, record.id)).orderBy(partyMember.joinedAt)
  return { id: record.id, ownerUserId: record.ownerUserId, inviteCode: record.inviteCode, members }
}

async function viewRoom(userId: string, roomId: string, database: RoomReader = db): Promise<RoomView> {
  const [record] = await database.select().from(room).where(eq(room.id, roomId)).limit(1)
  if (!record) throw new DomainError('not-found', 'Table not found.')

  const seatRows = await database.select({
    seat: roomSeat.seat,
    userId: roomSeat.userId,
    name: user.name,
    controller: roomSeat.controller,
    connected: roomSeat.connected,
  }).from(roomSeat).leftJoin(user, eq(roomSeat.userId, user.id)).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
  const viewer = seatRows.find((seat) => seat.userId === userId)
  if (!viewer) throw new DomainError('forbidden', 'You are not seated at this table.')

  const votes = await database.select({
    disconnectedSeat: disconnectVote.disconnectedSeat,
    voterUserId: disconnectVote.voterUserId,
    approveBot: disconnectVote.approveBot,
  }).from(disconnectVote).where(eq(disconnectVote.roomId, roomId))
  const disconnectedSeat = record.status === 'paused'
    ? votes[0]?.disconnectedSeat ?? seatRows.find((seat) => !seat.connected && seat.controller === 'human')?.seat
    : undefined
  const eligibleVoters = disconnectedSeat === undefined ? [] : eligibleBotVoters(seatRows as SeatView[], disconnectedSeat as Player)
  const rematchVotes = record.partyId && record.game?.phase === 'match-over'
    ? await database.select({ userId: rematchVote.userId }).from(rematchVote).where(eq(rematchVote.roomId, roomId))
    : []
  const humanSeats = seatRows.filter((seat) => seat.userId !== null)
  return {
    id: record.id,
    code: record.code,
    status: record.status,
    version: record.version,
    hostUserId: record.hostUserId,
    partyId: record.partyId,
    viewerSeat: viewer.seat as Player,
    rules: record.rules,
    seats: seatRows.map((seat) => ({ ...seat, name: seat.name ?? `Bot ${seat.seat}` })) as SeatView[],
    game: record.game ? projectGame(record.game, viewer.seat as Player) : null,
    disconnectVote: disconnectedSeat === undefined ? null : {
      disconnectedSeat: disconnectedSeat as Player,
      approvals: votes.filter((vote) => vote.approveBot && eligibleVoters.some((seat) => seat.userId === vote.voterUserId)).flatMap((vote) => {
        const voter = seatRows.find((seat) => seat.userId === vote.voterUserId)
        return voter ? [voter.seat as Player] : []
      }),
      requiredApprovals: eligibleVoters.length,
    },
    rematch: record.partyId && record.game?.phase === 'match-over' ? {
      confirmations: humanSeats.filter((seat) => rematchVotes.some((vote) => vote.userId === seat.userId)).map((seat) => seat.seat as Player),
      requiredConfirmations: 2,
    } : null,
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
        if (!record.game || status !== 'playing') return
        const elapsed = now.getTime() - record.updatedAt.getTime()
        const game = record.game.phase === 'trick-complete'
          ? elapsed >= 1_600 ? reduceGame(record.game, { type: 'collect-trick' }) : record.game
          : elapsed >= 900 ? advanceBot(record.game, currentSeats) : record.game
        if (game === record.game) return
        await tx.update(room).set({ game, status: statusForGame(game), version: version + 1, updatedAt: now }).where(eq(room.id, roomId))
      })
      return viewRoom(userId, roomId)
    },
    catch: failure,
  })),
  currentRoom: Effect.fn('GameService.currentRoom')((userId: string) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const [seat] = await tx.select({ roomId: roomSeat.roomId }).from(roomSeat)
        .innerJoin(room, eq(roomSeat.roomId, room.id))
        .where(eq(roomSeat.userId, userId)).orderBy(desc(room.updatedAt)).limit(1)
      return seat ? viewRoom(userId, seat.roomId, tx) : null
    }),
    catch: failure,
  })),
  currentParty: Effect.fn('GameService.currentParty')((userId: string) => Effect.tryPromise({
    try: () => db.transaction((tx) => viewParty(userId, tx)),
    catch: failure,
  })),
  createParty: Effect.fn('GameService.createParty')((userId: string) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const existing = await viewParty(userId, tx)
      if (existing) return existing
      const [created] = await tx.insert(party).values({ ownerUserId: userId }).returning()
      await tx.insert(partyMember).values({ partyId: created.id, userId })
      return (await viewParty(userId, tx))!
    }),
    catch: failure,
  })),
  joinParty: Effect.fn('GameService.joinParty')((userId: string, inviteCode: string) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const existing = await viewParty(userId, tx)
      if (existing) {
        if (existing.inviteCode === inviteCode) return existing
        throw new DomainError('conflict', 'Leave your current partnership before joining another.')
      }
      const [record] = await tx.select().from(party).where(eq(party.inviteCode, inviteCode)).for('update').limit(1)
      if (!record) throw new DomainError('not-found', 'Partner invite not found.')
      const members = await tx.select().from(partyMember).where(eq(partyMember.partyId, record.id))
      if (members.length >= 2) throw new DomainError('conflict', 'This partner invite has already been used.')
      await tx.insert(partyMember).values({ partyId: record.id, userId })
      await tx.update(party).set({ inviteCode: crypto.randomUUID(), updatedAt: new Date() }).where(eq(party.id, record.id))
      return (await viewParty(userId, tx))!
    }),
    catch: failure,
  })),
  leaveParty: Effect.fn('GameService.leaveParty')((userId: string) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [membership] = await tx.select().from(partyMember).where(eq(partyMember.userId, userId)).limit(1)
        if (!membership) throw new DomainError('not-found', 'Partnership not found.')
        const [record] = await tx.select().from(party).where(eq(party.id, membership.partyId)).for('update').limit(1)
        if (!record) throw new DomainError('not-found', 'Partnership not found.')
        const members = await tx.select().from(partyMember).where(eq(partyMember.partyId, record.id)).orderBy(partyMember.joinedAt)
        const remaining = members.filter((member) => member.userId !== userId)
        const [activeRoom] = await tx.select().from(room).where(and(eq(room.partyId, record.id), inArray(room.status, ['playing', 'paused', 'finished']))).orderBy(desc(room.updatedAt)).for('update').limit(1)
        if (activeRoom?.game) {
          const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, activeRoom.id)).orderBy(roomSeat.seat)
          const departingSeat = seats.find((seat) => seat.userId === userId)
          if (departingSeat) {
            await tx.update(roomSeat).set({ userId: null, controller: 'bot', connected: false, lastSeenAt: new Date() }).where(and(eq(roomSeat.roomId, activeRoom.id), eq(roomSeat.seat, departingSeat.seat)))
            await tx.delete(disconnectVote).where(and(eq(disconnectVote.roomId, activeRoom.id), eq(disconnectVote.disconnectedSeat, departingSeat.seat)))
            await tx.delete(rematchVote).where(and(eq(rematchVote.roomId, activeRoom.id), eq(rematchVote.userId, userId)))
            const controlledSeats = seats.map((seat) => seat.seat === departingSeat.seat ? { ...seat, userId: null, controller: 'bot' as const, connected: false } : seat)
            const hasDisconnectedHuman = controlledSeats.some((seat) => !seat.connected && seat.controller === 'human')
            const nextOwner = remaining[0]?.userId
            await tx.update(room).set({
              hostUserId: activeRoom.hostUserId === userId && nextOwner ? nextOwner : activeRoom.hostUserId,
              status: activeRoom.status === 'finished' ? 'finished' : statusForPresence(statusForGame(activeRoom.game), activeRoom.game.phase, hasDisconnectedHuman, false),
              version: activeRoom.version + 1,
              updatedAt: new Date(),
            }).where(eq(room.id, activeRoom.id))
          }
        }
        await tx.delete(partyMember).where(and(eq(partyMember.partyId, record.id), eq(partyMember.userId, userId)))
        if (remaining.length === 0) {
          await tx.delete(party).where(eq(party.id, record.id))
        } else {
          await tx.update(party).set({ ownerUserId: remaining[0].userId, inviteCode: crypto.randomUUID(), updatedAt: new Date() }).where(eq(party.id, record.id))
        }
      })
    },
    catch: failure,
  })),
  startPartyRoom: Effect.fn('GameService.startPartyRoom')((userId: string, rules: GameRules) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const [membership] = await tx.select().from(partyMember).where(eq(partyMember.userId, userId)).limit(1)
      if (!membership) throw new DomainError('not-found', 'Partnership not found.')
      const [record] = await tx.select().from(party).where(eq(party.id, membership.partyId)).for('update').limit(1)
      if (!record || record.ownerUserId !== userId) throw new DomainError('forbidden', 'Only the party creator can start a match.')
      const members = await tx.select().from(partyMember).where(eq(partyMember.partyId, record.id)).orderBy(partyMember.joinedAt)
      if (members.length !== 2) throw new DomainError('conflict', 'Invite a partner before starting a match.')
      const [activeRoom] = await tx.select().from(room).where(and(eq(room.partyId, record.id), inArray(room.status, ['playing', 'paused']))).orderBy(desc(room.updatedAt)).limit(1)
      if (activeRoom) return viewRoom(userId, activeRoom.id, tx)
      const game = createGame(undefined, rules)
      const [created] = await tx.insert(room).values({ code: randomCode(), hostUserId: userId, partyId: record.id, rules, status: 'playing', game }).returning()
      const partner = members.find((member) => member.userId !== userId)!
      await tx.insert(roomSeat).values([
        { roomId: created.id, seat: 0, userId, connected: true },
        { roomId: created.id, seat: 1, controller: 'bot' },
        { roomId: created.id, seat: 2, userId: partner.userId, connected: false },
        { roomId: created.id, seat: 3, controller: 'bot' },
      ])
      return viewRoom(userId, created.id, tx)
    }),
    catch: failure,
  })),
  createRoom: Effect.fn('GameService.createRoom')((userId: string, rules: GameRules) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
        const [created] = await tx.insert(room).values({ code: randomCode(), hostUserId: userId, rules }).returning()
        await tx.insert(roomSeat).values({ roomId: created.id, seat: 0, userId, connected: true })
        return viewRoom(userId, created.id, tx)
      }),
    catch: failure,
  })),
  createSinglePlayerRoom: Effect.fn('GameService.createSinglePlayerRoom')((userId: string, rules: GameRules) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
        const game = createGame(undefined, rules)
        const [created] = await tx.insert(room).values({
          code: randomCode(),
          hostUserId: userId,
          rules,
          status: 'playing',
          game,
        }).returning()
        await tx.insert(roomSeat).values([
          { roomId: created.id, seat: 0, userId, connected: true },
          { roomId: created.id, seat: 1, controller: 'bot' },
          { roomId: created.id, seat: 2, controller: 'bot' },
          { roomId: created.id, seat: 3, controller: 'bot' },
        ])
        return viewRoom(userId, created.id, tx)
      }),
    catch: failure,
  })),
  joinRoom: Effect.fn('GameService.joinRoom')((userId: string, code: string) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.code, code.toUpperCase())).for('update').limit(1)
        if (!record) throw new DomainError('not-found', 'Invite code not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, record.id)).orderBy(roomSeat.seat)
        const existing = seats.find((seat) => seat.userId === userId)
        if (existing) return viewRoom(userId, record.id, tx)
        if (record.status !== 'lobby' || seats.length >= 4) throw new DomainError('conflict', 'This table is already full.')
        await tx.insert(roomSeat).values({ roomId: record.id, seat: seats.length, userId, connected: true })
        if (seats.length === 3) {
          await tx.update(room).set({ status: 'playing', game: createGame(undefined, record.rules), version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, record.id))
        } else {
          await tx.update(room).set({ version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, record.id))
        }
        return viewRoom(userId, record.id, tx)
      }),
    catch: failure,
  })),
  leaveRoom: Effect.fn('GameService.leaveRoom')((userId: string, roomId: string) => Effect.tryPromise({
    try: async () => {
      await db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, roomId)).for('update').limit(1)
        if (!record) throw new DomainError('not-found', 'Table not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
        if (!seats.some((seat) => seat.userId === userId)) throw new DomainError('forbidden', 'You are not seated at this table.')
        const singlePlayer = seats.length === 4 && seats.every((seat) => seat.userId === userId || (seat.userId === null && seat.controller === 'bot'))
        if (record.partyId && record.status === 'finished') {
          await tx.delete(room).where(eq(room.id, roomId))
          return
        }
        if (record.status !== 'lobby') {
          if (!singlePlayer) throw new DomainError('conflict', 'You can only leave a multiplayer table before the match starts.')
          await tx.delete(room).where(eq(room.id, roomId))
          return
        }
        const remaining = seats.filter((seat) => seat.userId !== userId)
        await tx.delete(roomSeat).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, userId)))
        if (remaining.length === 0) {
          await tx.delete(room).where(eq(room.id, roomId))
          return
        }
        for (const [seat, occupant] of remaining.entries()) {
          if (occupant.seat !== seat) await tx.update(roomSeat).set({ seat }).where(and(eq(roomSeat.roomId, roomId), eq(roomSeat.userId, occupant.userId!)))
        }
        const hostUserId = record.hostUserId === userId ? remaining[0].userId! : record.hostUserId
        await tx.update(room).set({ hostUserId, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
      })
    },
    catch: failure,
  })),
  getRoom: Effect.fn('GameService.getRoom')((userId: string, roomId: string) => Effect.tryPromise({
    try: () => db.transaction((tx) => viewRoom(userId, roomId, tx)),
    catch: failure,
  })),
  submit: Effect.fn('GameService.submit')((userId: string, command: SubmitCommand) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
        const [record] = await tx.select().from(room).where(eq(room.id, command.roomId)).for('update').limit(1)
        if (!record?.game) throw new DomainError('not-found', 'Active game not found.')
        const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, command.roomId)).orderBy(roomSeat.seat)
        const actor = seats.find((seat) => seat.userId === userId)
        if (!actor) throw new DomainError('forbidden', 'You are not seated at this table.')
        const [duplicate] = await tx.select().from(roomCommand).where(and(eq(roomCommand.roomId, command.roomId), eq(roomCommand.commandId, command.commandId))).limit(1)
        if (duplicate) return viewRoom(userId, command.roomId, tx)
        if (!acceptsRoomAction(record.status, record.game.phase, command.action.type)) throw new DomainError('conflict', 'That action is not available in the current game state.')
        if (record.version !== command.expectedVersion) throw new DomainError('conflict', 'Your game view is stale.')
        if (actor.controller !== 'human') throw new DomainError('forbidden', 'This seat is currently controlled by a bot.')
        const hostAction = command.action.type === 'next-hand' || command.action.type === 'new-match'
        if (record.partyId && command.action.type === 'new-match') throw new DomainError('invalid', 'Both partners must confirm a rematch.')
        if (hostAction && record.hostUserId !== userId) throw new DomainError('forbidden', 'Only the host can advance the match.')
        if (!hostAction && record.game.activePlayer !== actor.seat) throw new DomainError('forbidden', 'It is not your turn.')
        const reduced = reduceGame(record.game, command.action as GameAction)
        if (reduced === record.game) throw new DomainError('invalid', 'That action is not legal now.')
        const hasDisconnectedHuman = seats.some((seat) => !seat.connected && seat.controller === 'human')
        const hostDisconnected = seats.some((seat) => seat.userId === record.hostUserId && !seat.connected && seat.controller === 'human')
        const status = statusForPresence(statusForGame(reduced), reduced.phase, hasDisconnectedHuman, hostDisconnected)
        await tx.insert(roomCommand).values({ roomId: command.roomId, commandId: command.commandId, userId, action: command.action as GameAction })
        await tx.update(room).set({ game: reduced, status, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, command.roomId))
        return viewRoom(userId, command.roomId, tx)
      }),
    catch: failure,
  })),
  voteForBot: Effect.fn('GameService.voteForBot')((userId: string, roomId: string, disconnectedSeat: Player, approve: boolean) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
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
          const status = controlledSeats.some((seat) => !seat.connected && seat.controller === 'human') ? 'paused' : statusForGame(record.game)
          const hostUserId = disconnected.userId === record.hostUserId ? eligibleVoters[0]?.userId ?? record.hostUserId : record.hostUserId
          await tx.update(room).set({ status, hostUserId, version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
          await tx.delete(disconnectVote).where(eq(disconnectVote.roomId, roomId))
        } else if (!previousVote || previousVote.approveBot !== approve) {
          await tx.update(room).set({ version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
        }
        return viewRoom(userId, roomId, tx)
      }),
    catch: failure,
  })),
  confirmRematch: Effect.fn('GameService.confirmRematch')((userId: string, roomId: string) => Effect.tryPromise({
    try: () => db.transaction(async (tx) => {
      const [record] = await tx.select().from(room).where(eq(room.id, roomId)).for('update').limit(1)
      if (!record?.partyId || !record.game || record.game.phase !== 'match-over') throw new DomainError('invalid', 'This match is not ready for a rematch.')
      const seats = await tx.select().from(roomSeat).where(eq(roomSeat.roomId, roomId)).orderBy(roomSeat.seat)
      const actor = seats.find((seat) => seat.userId === userId && seat.controller === 'human')
      const humans = seats.filter((seat) => seat.userId !== null)
      if (!actor) throw new DomainError('forbidden', 'You are not seated at this table.')
      if (humans.length !== 2) throw new DomainError('conflict', 'A partner is required for a rematch.')
      await tx.insert(rematchVote).values({ roomId, userId }).onConflictDoNothing()
      const votes = await tx.select().from(rematchVote).where(eq(rematchVote.roomId, roomId))
      if (humans.every((seat) => votes.some((vote) => vote.userId === seat.userId))) {
        const game = reduceGame(record.game, { type: 'new-match' })
        await tx.delete(rematchVote).where(eq(rematchVote.roomId, roomId))
        await tx.update(room).set({ game, status: statusForGame(game), version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
      } else {
        await tx.update(room).set({ version: record.version + 1, updatedAt: new Date() }).where(eq(room.id, roomId))
      }
      return viewRoom(userId, roomId, tx)
    }),
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
