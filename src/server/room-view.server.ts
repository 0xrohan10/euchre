import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import type { Database } from '../db/index.server'
import {
  activeRoomMembership,
  disconnectVote,
  playerRating,
  rematchVote,
  room,
  roomCommand,
  roomSeat,
} from '../db/schema'
import type { Player } from '../game/player'
import { BASE_SKILL_RATING, type RatingMode } from '../game/skill'
import { eligibleBotVoters, projectGame, type RoomView } from '../multiplayer'

type RoomReader = Pick<Database, 'select'>

export type RoomSnapshotSeat = typeof roomSeat.$inferSelect & { name: string | null }
type RoomSnapshotRating = Pick<
  typeof playerRating.$inferSelect,
  'userId' | 'mode' | 'rating' | 'gamesPlayed'
>
type RoomSnapshotCommand = Pick<typeof roomCommand.$inferSelect, 'roomId' | 'commandId'>

export type RoomSnapshot = {
  room: typeof room.$inferSelect
  seats: RoomSnapshotSeat[]
  ratings: RoomSnapshotRating[]
  disconnectVotes: (typeof disconnectVote.$inferSelect)[]
  rematchVotes: (typeof rematchVote.$inferSelect)[]
  command: RoomSnapshotCommand | null
}

type SnapshotOptions = {
  commandId?: string
  forUpdate?: boolean
}

type SnapshotChildren = Omit<RoomSnapshot, 'room'>

function ratingModeForSnapshot(snapshot: RoomSnapshot): RatingMode {
  if (snapshot.room.game) {
    return snapshot.room.game.ratingMode ?? 'assisted'
  }
  return snapshot.seats.length < 4 ||
    snapshot.seats.every((seat) => {
      return seat.userId !== null && seat.controller === 'human'
    })
    ? 'competitive'
    : 'assisted'
}

function childSelection(roomId: SQL, commandId?: string) {
  return {
    seats: sql<RoomSnapshotSeat[]>`
      coalesce((
        select jsonb_agg(bounded.value order by bounded.seat)
        from (
          select
            jsonb_build_object(
              'roomId', room_seat.room_id,
              'seat', room_seat.seat,
              'userId', room_seat.user_id,
              'controller', room_seat.controller,
              'connected', room_seat.connected,
              'lastSeenAt', room_seat.last_seen_at,
              'joinedAt', room_seat.joined_at,
              'name', "user".name
            ) as value,
            room_seat.seat
          from room_seat
          left join "user" on "user".id = room_seat.user_id
          where room_seat.room_id = ${roomId}
          order by room_seat.seat
          limit 4
        ) bounded
      ), '[]'::jsonb)
    `,
    ratings: sql<RoomSnapshotRating[]>`
      coalesce((
        select jsonb_agg(bounded.value order by bounded.user_id, bounded.mode)
        from (
          select
            jsonb_build_object(
              'userId', player_rating.user_id,
              'mode', player_rating.mode,
              'rating', player_rating.rating,
              'gamesPlayed', player_rating.games_played
            ) as value,
            player_rating.user_id,
            player_rating.mode
          from player_rating
          where player_rating.mode in ('competitive', 'assisted')
            and player_rating.user_id in (
              select room_seat.user_id
              from room_seat
              where room_seat.room_id = ${roomId} and room_seat.user_id is not null
              limit 4
            )
          order by player_rating.user_id, player_rating.mode
          limit 8
        ) bounded
      ), '[]'::jsonb)
    `,
    disconnectVotes: sql<(typeof disconnectVote.$inferSelect)[]>`
      coalesce((
        select jsonb_agg(
          bounded.value order by bounded.disconnected_seat, bounded.voter_user_id
        )
        from (
          select
            jsonb_build_object(
              'roomId', disconnect_vote.room_id,
              'disconnectedSeat', disconnect_vote.disconnected_seat,
              'voterUserId', disconnect_vote.voter_user_id,
              'approveBot', disconnect_vote.approve_bot,
              'createdAt', disconnect_vote.created_at
            ) as value,
            disconnect_vote.disconnected_seat,
            disconnect_vote.voter_user_id
          from disconnect_vote
          where disconnect_vote.room_id = ${roomId}
          order by disconnect_vote.disconnected_seat, disconnect_vote.voter_user_id
          limit 12
        ) bounded
      ), '[]'::jsonb)
    `,
    rematchVotes: sql<(typeof rematchVote.$inferSelect)[]>`
      coalesce((
        select jsonb_agg(bounded.value order by bounded.user_id)
        from (
          select
            jsonb_build_object(
              'roomId', rematch_vote.room_id,
              'userId', rematch_vote.user_id,
              'createdAt', rematch_vote.created_at
            ) as value,
            rematch_vote.user_id
          from rematch_vote
          where rematch_vote.room_id = ${roomId}
          order by rematch_vote.user_id
          limit 4
        ) bounded
      ), '[]'::jsonb)
    `,
    command: commandId
      ? sql<RoomSnapshotCommand | null>`(
          select jsonb_build_object(
            'roomId', room_command.room_id,
            'commandId', room_command.command_id
          )
          from room_command
          where room_command.room_id = ${roomId}
            and room_command.command_id = ${commandId}
          limit 1
        )`
      : sql<RoomSnapshotCommand | null>`null::jsonb`,
  }
}

function hydrateChildren(children: SnapshotChildren): SnapshotChildren {
  return {
    ...children,
    seats: children.seats.map((seat) => {
      return {
        ...seat,
        lastSeenAt: new Date(seat.lastSeenAt),
        joinedAt: new Date(seat.joinedAt),
      }
    }),
    disconnectVotes: children.disconnectVotes.map((vote) => {
      return { ...vote, createdAt: new Date(vote.createdAt) }
    }),
    rematchVotes: children.rematchVotes.map((vote) => {
      return { ...vote, createdAt: new Date(vote.createdAt) }
    }),
  }
}

async function loadRoomChildren(
  database: RoomReader,
  roomId: string,
  commandId?: string,
): Promise<SnapshotChildren> {
  const [children] = await database
    .select(childSelection(sql`${roomId}`, commandId))
    .from(sql`(select 1) as snapshot_source`)
  return hydrateChildren(children)
}

export async function loadRoomSnapshot(
  database: RoomReader,
  roomId: string,
  options: SnapshotOptions = {},
): Promise<RoomSnapshot | null> {
  if (options.forUpdate) {
    const [record] = await database
      .select()
      .from(room)
      .where(eq(room.id, roomId))
      .for('update', { of: room })
      .limit(1)
    if (!record) {
      return null
    }
    return { room: record, ...(await loadRoomChildren(database, roomId, options.commandId)) }
  }

  const [snapshot] = await database
    .select({ room, ...childSelection(sql`${room.id}`, options.commandId) })
    .from(room)
    .where(eq(room.id, roomId))
    .limit(1)
  if (!snapshot) {
    return null
  }
  const { room: record, ...children } = snapshot
  return { room: record, ...hydrateChildren(children) }
}

export async function loadLatestRoomSnapshot(
  database: RoomReader,
  userId: string,
): Promise<RoomSnapshot | null> {
  const activeRoom = database
    .select({ id: activeRoomMembership.roomId })
    .from(activeRoomMembership)
    .where(eq(activeRoomMembership.userId, userId))
    .limit(1)
  const latestFinishedRoom = database
    .select({ id: roomSeat.roomId })
    .from(roomSeat)
    .innerJoin(room, eq(roomSeat.roomId, room.id))
    .where(and(eq(roomSeat.userId, userId), eq(room.status, 'finished')))
    .orderBy(desc(room.updatedAt))
    .limit(1)
  const [snapshot] = await database
    .select({ room, ...childSelection(sql`${room.id}`) })
    .from(room)
    .where(eq(room.id, sql`coalesce((${activeRoom}), (${latestFinishedRoom}))`))
    .limit(1)
  if (!snapshot) {
    return null
  }
  const { room: record, ...children } = snapshot
  return { room: record, ...hydrateChildren(children) }
}

export function projectRoomSnapshot(snapshot: RoomSnapshot, userId: string): RoomView | null {
  const viewer = snapshot.seats.find((seat) => {
    return seat.userId === userId
  })
  if (!viewer) {
    return null
  }
  const { room: record, seats } = snapshot
  const ratingMode = ratingModeForSnapshot(snapshot)
  const ratingsByUser = new Map(
    snapshot.ratings
      .filter((rating) => {
        return rating.mode === ratingMode
      })
      .map((rating) => {
        return [rating.userId, rating]
      }),
  )
  const votes = record.status === 'paused' ? snapshot.disconnectVotes : []
  const disconnectedSeat =
    record.status === 'paused'
      ? (votes[0]?.disconnectedSeat ??
        seats.find((seat) => {
          return !seat.connected && seat.controller === 'human'
        })?.seat)
      : undefined
  const eligibleVoters =
    disconnectedSeat === undefined ? [] : eligibleBotVoters(seats, disconnectedSeat as Player)
  const humanSeats = seats.filter((seat) => {
    return seat.userId !== null
  })

  return {
    id: record.id,
    code: record.code,
    status: record.status,
    version: record.version,
    hostUserId: record.hostUserId,
    partyId: record.partyId,
    viewerSeat: viewer.seat as Player,
    rules: record.rules,
    seats: seats.map((seat) => {
      const rating = seat.userId ? ratingsByUser.get(seat.userId) : undefined
      return {
        seat: seat.seat as Player,
        userId: seat.userId,
        name: seat.name ?? `Bot ${seat.seat}`,
        controller: seat.controller,
        connected: seat.connected,
        rating: seat.userId ? (rating?.rating ?? BASE_SKILL_RATING) : null,
        ratingGames: rating?.gamesPlayed ?? 0,
        ratingMode,
      }
    }),
    game: record.game ? projectGame(record.game, viewer.seat as Player) : null,
    disconnectVote:
      disconnectedSeat === undefined
        ? null
        : {
            disconnectedSeat: disconnectedSeat as Player,
            approvals: votes
              .filter((vote) => {
                return (
                  vote.approveBot &&
                  eligibleVoters.some((seat) => {
                    return seat.userId === vote.voterUserId
                  })
                )
              })
              .flatMap((vote) => {
                const voter = seats.find((seat) => {
                  return seat.userId === vote.voterUserId
                })
                return voter ? [voter.seat as Player] : []
              }),
            requiredApprovals: eligibleVoters.length,
          },
    rematch:
      record.partyId && record.game?.phase === 'match-over'
        ? {
            confirmations: humanSeats
              .filter((seat) => {
                return snapshot.rematchVotes.some((vote) => {
                  return vote.userId === seat.userId
                })
              })
              .map((seat) => {
                return seat.seat as Player
              }),
            requiredConfirmations: 2,
          }
        : null,
  }
}
