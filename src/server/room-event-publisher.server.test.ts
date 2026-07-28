import { describe, expect, it } from 'vitest'
import type { RoomView } from '../multiplayer'
import { createRoomEventPublisher } from './room-event-publisher.server'

function roomFixture(overrides: Partial<RoomView> = {}): RoomView {
  return {
    id: 'room-1',
    code: 'ABC123',
    status: 'playing',
    version: 1,
    hostUserId: 'host',
    partyId: null,
    viewerSeat: 0,
    rules: {
      stickDealer: true,
      requireNaturalTrump: true,
      allowAloneWhenOrderingPartner: false,
      allowFarmersHand: false,
    },
    seats: [
      {
        seat: 0,
        userId: 'host',
        name: 'Host',
        controller: 'human',
        connected: true,
        rating: 1000,
        ratingGames: 0,
        ratingMode: 'assisted',
      },
      {
        seat: 1,
        userId: null,
        name: 'Bot 1',
        controller: 'bot',
        connected: false,
        rating: null,
        ratingGames: 0,
        ratingMode: 'assisted',
      },
      {
        seat: 2,
        userId: 'partner',
        name: 'Partner',
        controller: 'human',
        connected: true,
        rating: 1000,
        ratingGames: 0,
        ratingMode: 'assisted',
      },
      {
        seat: 3,
        userId: null,
        name: 'Bot 3',
        controller: 'bot',
        connected: false,
        rating: null,
        ratingGames: 0,
        ratingMode: 'assisted',
      },
    ],
    game: null,
    disconnectVote: null,
    rematch: null,
    ...overrides,
  }
}

describe('createRoomEventPublisher', () => {
  it('sends the first room payload', () => {
    const frames: string[] = []
    const publisher = createRoomEventPublisher(
      (frame) => {
        frames.push(frame)
      },
      () => {},
    )
    const view = roomFixture()

    expect(publisher.publish(view)).toEqual({ sent: true })
    expect(frames).toEqual([`event: room\ndata: ${JSON.stringify(view)}\n\n`])
  })

  it('suppresses byte-identical subsequent payloads', () => {
    const frames: string[] = []
    const publisher = createRoomEventPublisher(
      (frame) => {
        frames.push(frame)
      },
      () => {},
    )
    const first = roomFixture()
    const second = roomFixture()

    expect(publisher.publish(first)).toEqual({ sent: true })
    expect(publisher.publish(second)).toEqual({ sent: false })
    expect(frames).toHaveLength(1)
  })

  it('sends same-version presence changes', () => {
    const frames: string[] = []
    const publisher = createRoomEventPublisher(
      (frame) => {
        frames.push(frame)
      },
      () => {},
    )
    const connected = roomFixture({
      seats: [
        {
          seat: 0,
          userId: 'host',
          name: 'Host',
          controller: 'human',
          connected: true,
          rating: 1000,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 1,
          userId: null,
          name: 'Bot 1',
          controller: 'bot',
          connected: false,
          rating: null,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 2,
          userId: 'partner',
          name: 'Partner',
          controller: 'human',
          connected: true,
          rating: 1000,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 3,
          userId: null,
          name: 'Bot 3',
          controller: 'bot',
          connected: false,
          rating: null,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
      ],
    })
    const disconnected = roomFixture({
      seats: [
        {
          seat: 0,
          userId: 'host',
          name: 'Host',
          controller: 'human',
          connected: true,
          rating: 1000,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 1,
          userId: null,
          name: 'Bot 1',
          controller: 'bot',
          connected: false,
          rating: null,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 2,
          userId: 'partner',
          name: 'Partner',
          controller: 'human',
          connected: false,
          rating: 1000,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
        {
          seat: 3,
          userId: null,
          name: 'Bot 3',
          controller: 'bot',
          connected: false,
          rating: null,
          ratingGames: 0,
          ratingMode: 'assisted',
        },
      ],
    })

    expect(publisher.publish(connected)).toEqual({ sent: true })
    expect(publisher.publish(disconnected)).toEqual({ sent: true })
    expect(frames).toHaveLength(2)
  })

  it('sends higher-version changes', () => {
    const frames: string[] = []
    const publisher = createRoomEventPublisher(
      (frame) => {
        frames.push(frame)
      },
      () => {},
    )

    expect(publisher.publish(roomFixture({ version: 1 }))).toEqual({ sent: true })
    expect(publisher.publish(roomFixture({ version: 2 }))).toEqual({ sent: true })
    expect(frames).toHaveLength(2)
  })

  it('keeps last payload only after successful enqueue and retries after failure', () => {
    const frames: string[] = []
    let shouldThrow = true
    let cleaned = 0
    const publisher = createRoomEventPublisher(
      (frame) => {
        if (shouldThrow) {
          throw new Error('enqueue failed')
        }
        frames.push(frame)
      },
      () => {
        cleaned += 1
      },
    )
    const view = roomFixture()

    expect(publisher.publish(view)).toEqual({ sent: false })
    expect(cleaned).toBe(1)
    expect(frames).toHaveLength(0)

    shouldThrow = false
    expect(publisher.publish(view)).toEqual({ sent: true })
    expect(frames).toHaveLength(1)
    expect(publisher.publish(view)).toEqual({ sent: false })
  })

  it('keeps publisher state stream-local', () => {
    const firstFrames: string[] = []
    const secondFrames: string[] = []
    const first = createRoomEventPublisher(
      (frame) => {
        firstFrames.push(frame)
      },
      () => {},
    )
    const second = createRoomEventPublisher(
      (frame) => {
        secondFrames.push(frame)
      },
      () => {},
    )
    const view = roomFixture()

    expect(first.publish(view)).toEqual({ sent: true })
    expect(second.publish(view)).toEqual({ sent: true })
    expect(firstFrames).toHaveLength(1)
    expect(secondFrames).toHaveLength(1)
  })
})
