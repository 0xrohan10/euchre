import { expect, it } from 'vitest'
import { createDeck, createGame } from './game'
import { acceptRoomUpdate, acceptsRoomAction, canPassCalling, eligibleBotVoters, playerAt, projectGame, relativePlayer, statusForGame, statusForPresence, type RoomView, type SeatView } from './multiplayer'

it('projects only the authenticated player hand', () => {
  const game = createGame(createDeck())
  const view = projectGame(game, 2)

  expect(view.hand).toEqual(game.hands[2])
  expect(view.handCounts).toEqual([5, 5, 5, 5])
  expect('hands' in view).toBe(false)
  expect('kitty' in view).toBe(false)
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

  expect(eligibleBotVoters(seats, 0).map((seat) => seat.userId)).toEqual(['b'])
})
