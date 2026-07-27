import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import type { GameAction, GameRules, GameState } from '../../game'
import { user } from './auth'

export const roomStatus = pgEnum('room_status', ['lobby', 'playing', 'paused', 'finished'])
export const seatController = pgEnum('seat_controller', ['human', 'bot'])

export const room = pgTable('room', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 6 }).notNull().unique(),
  hostUserId: text('host_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  status: roomStatus('status').notNull().default('lobby'),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  rules: jsonb('rules').$type<GameRules>().notNull(),
  game: jsonb('game').$type<GameState>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('room_host_user_id_idx').on(table.hostUserId)])

export const roomSeat = pgTable('room_seat', {
  roomId: uuid('room_id').notNull().references(() => room.id, { onDelete: 'cascade' }),
  seat: integer('seat').notNull(),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  controller: seatController('controller').notNull().default('human'),
  connected: boolean('connected').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.seat] }),
  uniqueIndex('room_seat_room_user_idx').on(table.roomId, table.userId),
])

export const roomCommand = pgTable('room_command', {
  roomId: uuid('room_id').notNull().references(() => room.id, { onDelete: 'cascade' }),
  commandId: uuid('command_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  action: jsonb('action').$type<GameAction>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.roomId, table.commandId] })])

export const disconnectVote = pgTable('disconnect_vote', {
  roomId: uuid('room_id').notNull().references(() => room.id, { onDelete: 'cascade' }),
  disconnectedSeat: integer('disconnected_seat').notNull(),
  voterUserId: text('voter_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  approveBot: boolean('approve_bot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [primaryKey({ columns: [table.roomId, table.disconnectedSeat, table.voterUserId] })])
