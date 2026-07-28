import { expect, it } from 'vitest'
import { createDeck } from './game/card'
import { createGame } from './game/deal'
import {
  acceptRoomUpdate,
  acceptsRoomAction,
  advanceBot,
  canPassCalling,
  eligibleBotVoters,
  optimisticRoomAction,
  playerAt,
  projectGame,
  relativePlayer,
  roomViewWithPendingAction,
  statusForGame,
  statusForPresence,
  type RoomView,
  type SeatView,
} from './multiplayer'

it('projects only the authenticated player hand', () => {
  const game = createGame(createDeck())
  const view = projectGame(game, 2)

  expect(view.hand).toEqual(game.hands[2])
  expect(view.handCounts).toEqual([5, 5, 5, 5])
  expect('hands' in view).toBe(false)
  expect('kitty' in view).toBe(false)
  expect('initialHands' in view).toBe(false)
  expect('ratingParticipants' in view).toBe(false)
})

it('rotates canonical seats around each viewer', () => {
  expect(playerAt(2, 0)).toBe(2)
  expect(playerAt(2, 1)).toBe(3)
  expect(relativePlayer(0, 2)).toBe(2)
  expect(relativePlayer(1, 2)).toBe(3)
})

it('only permits a rematch from a finished match', () => {
  expect(acceptsRoomAction('playing', 'playing', 'new-match')).toBe(false)
  expect(acceptsRoomAction('finished', 'match-over', 'new-match')).toBe(true)
  expect(acceptsRoomAction('finished', 'match-over', 'play')).toBe(false)
  expect(statusForGame({ phase: 'match-over' })).toBe('finished')
  expect(statusForGame({ phase: 'ordering' })).toBe('playing')
})

it('pauses a finished match only when its host disconnects', () => {
  expect(statusForPresence('finished', 'match-over', true, false)).toBe('finished')
  expect(statusForPresence('finished', 'match-over', true, true)).toBe('paused')
  expect(statusForPresence('paused', 'match-over', false, false)).toBe('finished')
  expect(statusForPresence('paused', 'playing', false, false)).toBe('playing')
})

it('never replaces a newer room view with a stale response', () => {
  const current = { id: 'room', version: 2 } as RoomView
  const stale = { id: 'room', version: 1 } as RoomView
  const otherRoom = { id: 'other', version: 1 } as RoomView

  expect(acceptRoomUpdate(current, stale)).toBe(current)
  expect(acceptRoomUpdate(current, otherRoom)).toBe(otherRoom)
})

it('optimistically moves a played card from the hand to the trick', () => {
  const game = createGame(createDeck())
  game.phase = 'playing'
  game.activePlayer = 0
  game.trump = 'clubs'
  const room = { id: 'room', viewerSeat: 0, game: projectGame(game, 0) } as RoomView
  const card = room.game!.hand[0]

  const optimistic = optimisticRoomAction(room, { type: 'play', cardId: card.id })

  expect(optimistic.game!.hand).not.toContainEqual(card)
  expect(optimistic.game!.handCounts[0]).toBe(4)
  expect(optimistic.game!.trick.at(-1)).toEqual({ player: 0, card })
  expect(room.game!.hand).toContainEqual(card)
})

it('keeps an optimistic play visible through a same-version room update', () => {
  const game = createGame(createDeck())
  game.phase = 'playing'
  game.activePlayer = 0
  game.trump = 'clubs'
  const room = {
    id: 'room',
    version: 4,
    viewerSeat: 0,
    game: projectGame(game, 0),
  } as RoomView
  const card = room.game!.hand[0]
  const optimistic = optimisticRoomAction(room, { type: 'play', cardId: card.id })

  const pending = { baseVersion: room.version, room: optimistic }
  const afterStreamUpdate = roomViewWithPendingAction(room, pending)

  expect(afterStreamUpdate.game!.hand).not.toContainEqual(card)
  expect(afterStreamUpdate.game!.trick.at(-1)).toEqual({ player: 0, card })

  const confirmed = { ...optimistic, version: room.version + 1 }
  expect(roomViewWithPendingAction(confirmed, pending)).toBe(confirmed)
})

it('optimistically advances bidding with the shared game reducer', () => {
  const game = createGame(createDeck())
  const room = {
    id: 'room',
    viewerSeat: game.activePlayer,
    game: projectGame(game, game.activePlayer),
  } as RoomView

  const passed = optimisticRoomAction(room, { type: 'pass' })

  expect(passed.game!.activePlayer).toBe((game.activePlayer + 1) % 4)
  expect(passed.game!.notice).toContain('passes')
  expect(room.game!.activePlayer).toBe(game.activePlayer)
})

it('optimistically orders up the dealer', () => {
  const game = createGame(createDeck())
  game.rules.requireNaturalTrump = false
  const room = {
    id: 'room',
    viewerSeat: game.activePlayer,
    game: projectGame(game, game.activePlayer),
  } as RoomView

  const ordered = optimisticRoomAction(room, { type: 'order-up', alone: true })

  expect(ordered.game).toMatchObject({
    phase: 'discarding',
    activePlayer: game.dealer,
    trump: game.upCard.suit,
    maker: game.activePlayer,
    lonePlayer: game.activePlayer,
  })
  expect(ordered.game!.handCounts[game.dealer]).toBe(6)
})

it('allows the stuck dealer to redeal when no suit is callable', () => {
  expect(canPassCalling(true, true, 0)).toBe(true)
  expect(canPassCalling(true, true, 1)).toBe(false)
  expect(canPassCalling(false, true, 1)).toBe(true)
})

it('counts only connected human voters', () => {
  const seats = [
    { seat: 0, userId: 'a', connected: false, controller: 'human' },
    { seat: 1, userId: 'b', connected: true, controller: 'human' },
    { seat: 2, userId: 'c', connected: false, controller: 'human' },
    { seat: 3, userId: 'd', connected: true, controller: 'bot' },
  ] as SeatView[]

  expect(
    eligibleBotVoters(seats, 0).map((seat) => {
      return seat.userId
    }),
  ).toEqual(['b'])
})

it('advances only one bot turn so each decision can be shown', () => {
  const game = createGame(createDeck())
  game.phase = 'playing'
  game.activePlayer = 1
  game.trump = 'clubs'
  game.maker = 1
  const seats = [
    { seat: 0, controller: 'human' as const },
    { seat: 1, controller: 'bot' as const },
    { seat: 2, controller: 'bot' as const },
    { seat: 3, controller: 'bot' as const },
  ]

  const result = advanceBot(game, seats)

  expect(result.activePlayer).toBe(2)
  expect(
    result.trick.map(({ player }) => {
      return player
    }),
  ).toEqual([1])
})
