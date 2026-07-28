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
