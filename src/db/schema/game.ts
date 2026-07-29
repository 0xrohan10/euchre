import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type { GameRules } from '../../game/rules'
import type { GameHistorySeat } from '../../game/history'
import type { GameAction, GameState } from '../../game/state'
import type { Team } from '../../game/player'
import type { HandResult, RatingMode } from '../../game/skill'
import { user } from './auth'

export const roomStatus = pgEnum('room_status', ['lobby', 'playing', 'paused', 'finished'])
export const seatController = pgEnum('seat_controller', ['human', 'bot'])

export const party = pgTable(
  'party',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    inviteCode: uuid('invite_code').notNull().defaultRandom().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [index('party_owner_user_id_idx').on(table.ownerUserId)]
  },
)

export const partyMember = pgTable(
  'party_member',
  {
    partyId: uuid('party_id')
      .notNull()
      .references(
        () => {
          return party.id
        },
        { onDelete: 'cascade' },
      ),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.partyId, table.userId] }),
      uniqueIndex('party_member_user_id_idx').on(table.userId),
    ]
  },
)

export const partyJoin = pgTable(
  'party_join',
  {
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    inviteCode: uuid('invite_code').notNull(),
    partyId: uuid('party_id')
      .notNull()
      .references(
        () => {
          return party.id
        },
        { onDelete: 'cascade' },
      ),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.inviteCode] }),
      index('party_join_party_id_idx').on(table.partyId),
    ]
  },
)

export const room = pgTable(
  'room',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 6 }).notNull().unique(),
    hostUserId: text('host_user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    partyId: uuid('party_id').references(
      () => {
        return party.id
      },
      { onDelete: 'set null' },
    ),
    matchId: uuid('match_id').notNull().defaultRandom(),
    status: roomStatus('status').notNull().default('lobby'),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    rules: jsonb('rules').$type<GameRules>().notNull(),
    game: jsonb('game').$type<GameState>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      index('room_host_user_id_idx').on(table.hostUserId),
      index('room_party_id_idx').on(table.partyId),
    ]
  },
)

export const activeRoomMembership = pgTable(
  'active_room_membership',
  {
    userId: text('user_id')
      .primaryKey()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    roomId: uuid('room_id')
      .notNull()
      .references(
        () => {
          return room.id
        },
        { onDelete: 'cascade' },
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [index('active_room_membership_room_id_idx').on(table.roomId)]
  },
)

export const roomCreation = pgTable(
  'room_creation',
  {
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    operationId: uuid('operation_id').notNull(),
    operationKind: varchar('operation_kind', { length: 24 })
      .$type<'multiplayer' | 'single-player'>()
      .notNull(),
    roomId: uuid('room_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.operationId] }),
      index('room_creation_room_id_idx').on(table.roomId),
    ]
  },
)

export const gameHistory = pgTable(
  'game_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceRoomId: uuid('source_room_id').notNull(),
    sourceMatchId: uuid('source_match_id').notNull(),
    score0: integer('score_0').notNull(),
    score1: integer('score_1').notNull(),
    handCount: integer('hand_count').notNull(),
    rules: jsonb('rules').$type<GameRules>().notNull(),
    seats: jsonb('seats').$type<GameHistorySeat[]>().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      uniqueIndex('game_history_source_match_id_idx').on(table.sourceMatchId),
      index('game_history_completed_at_idx').on(table.completedAt),
    ]
  },
)

export const gameHistoryParticipant = pgTable(
  'game_history_participant',
  {
    gameHistoryId: uuid('game_history_id')
      .notNull()
      .references(
        () => {
          return gameHistory.id
        },
        { onDelete: 'cascade' },
      ),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.gameHistoryId, table.userId] }),
      index('game_history_participant_user_id_idx').on(table.userId),
    ]
  },
)

export const ratedMatch = pgTable('rated_match', {
  gameHistoryId: uuid('game_history_id')
    .primaryKey()
    .references(
      () => {
        return gameHistory.id
      },
      { onDelete: 'cascade' },
    ),
  ratedAt: timestamp('rated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const pendingRating = pgTable(
  'pending_rating',
  {
    gameHistoryId: uuid('game_history_id')
      .primaryKey()
      .references(
        () => {
          return gameHistory.id
        },
        { onDelete: 'cascade' },
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    mode: varchar('mode', { length: 16 }).$type<RatingMode>(),
    participants: jsonb('participants').$type<GameState['ratingParticipants']>(),
    forfeitTeam: integer('forfeit_team').$type<Team>(),
    handResults: jsonb('hand_results').$type<HandResult[]>(),
  },
  (table) => {
    return [index('pending_rating_created_at_idx').on(table.createdAt)]
  },
)

export const ratingOutbox = pgTable(
  'rating_outbox',
  {
    gameHistoryId: uuid('game_history_id')
      .primaryKey()
      .references(
        () => {
          return gameHistory.id
        },
        { onDelete: 'cascade' },
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    mode: varchar('mode', { length: 16 }).$type<RatingMode>().notNull(),
    participants: jsonb('participants')
      .$type<NonNullable<GameState['ratingParticipants']>>()
      .notNull(),
    forfeitTeam: integer('forfeit_team').$type<Team>(),
    handResults: jsonb('hand_results').$type<HandResult[]>(),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
  },
  (table) => {
    return [index('rating_outbox_created_at_idx').on(table.createdAt)]
  },
)

export const playerRating = pgTable(
  'player_rating',
  {
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    mode: varchar('mode', { length: 16 }).$type<RatingMode>().notNull(),
    rating: integer('rating').notNull().default(1000),
    gamesPlayed: integer('games_played').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    losses: integer('losses').notNull().default(0),
    handsPlayed: integer('hands_played').notNull().default(0),
    calls: integer('calls').notNull().default(0),
    callsWon: integer('calls_won').notNull().default(0),
    partnerCalls: integer('partner_calls').notNull().default(0),
    partnerCallsWon: integer('partner_calls_won').notNull().default(0),
    defenses: integer('defenses').notNull().default(0),
    defensesWon: integer('defenses_won').notNull().default(0),
    tricksWon: integer('tricks_won').notNull().default(0),
    expectedTricksMilli: integer('expected_tricks_milli').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.mode] }),
      index('player_rating_mode_rating_idx').on(table.mode, table.rating),
    ]
  },
)

export const roomSeat = pgTable(
  'room_seat',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(
        () => {
          return room.id
        },
        { onDelete: 'cascade' },
      ),
    seat: integer('seat').notNull(),
    userId: text('user_id').references(
      () => {
        return user.id
      },
      { onDelete: 'cascade' },
    ),
    controller: seatController('controller').notNull().default('human'),
    connected: boolean('connected').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.roomId, table.seat] }),
      uniqueIndex('room_seat_room_user_idx').on(table.roomId, table.userId),
      index('room_seat_user_id_idx').on(table.userId),
    ]
  },
)

export const roomCommand = pgTable(
  'room_command',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(
        () => {
          return room.id
        },
        { onDelete: 'cascade' },
      ),
    commandId: uuid('command_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    action: jsonb('action').$type<GameAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [primaryKey({ columns: [table.roomId, table.commandId] })]
  },
)

export const disconnectVote = pgTable(
  'disconnect_vote',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(
        () => {
          return room.id
        },
        { onDelete: 'cascade' },
      ),
    disconnectedSeat: integer('disconnected_seat').notNull(),
    voterUserId: text('voter_user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    approveBot: boolean('approve_bot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [primaryKey({ columns: [table.roomId, table.disconnectedSeat, table.voterUserId] })]
  },
)

export const rematchVote = pgTable(
  'rematch_vote',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(
        () => {
          return room.id
        },
        { onDelete: 'cascade' },
      ),
    userId: text('user_id')
      .notNull()
      .references(
        () => {
          return user.id
        },
        { onDelete: 'cascade' },
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => {
    return [primaryKey({ columns: [table.roomId, table.userId] })]
  },
)
