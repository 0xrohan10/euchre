import type { RoomView } from '../multiplayer'

export type RoomEventPublisher = {
  publish: (view: RoomView) => { sent: boolean }
}

export function createRoomEventPublisher(
  enqueue: (frame: string) => void,
  cleanup: () => void,
): RoomEventPublisher {
  let lastPayload: string | undefined

  return {
    publish(view) {
      const payload = JSON.stringify(view)
      if (payload === lastPayload) {
        return { sent: false }
      }
      const frame = `event: room\ndata: ${payload}\n\n`
      try {
        enqueue(frame)
      } catch {
        cleanup()
        return { sent: false }
      }
      lastPayload = payload
      return { sent: true }
    },
  }
}
