import { env, waitUntil } from 'cloudflare:workers'
import { createDb } from '../db/index.server'
import {
  roomCoordinatorMode,
  shadowRoomCoordinator,
  shouldUseRoomCoordinator,
} from './room-coordinator-policy'
import { dispatchPendingRoomWakeups } from './room-wakeup.server'

export function pokeRoomCoordinator(roomId: string): void {
  const mode = roomCoordinatorMode(env.ROOM_COORDINATOR_MODE)
  const percentage = Number(env.ROOM_COORDINATOR_PERCENTAGE)
  if (
    !shouldUseRoomCoordinator(roomId, mode, percentage) &&
    !shadowRoomCoordinator(roomId, mode, percentage)
  ) {
    return
  }
  waitUntil(
    dispatchPendingRoomWakeups(createDb(), env.ROOM_WAKEUP_QUEUE, 10).then(() => {
      return undefined
    }),
  )
}

export function scheduleRoomCoordinatorPoke(
  namespace: Pick<DurableObjectNamespace, 'getByName'>,
  roomId: string,
  defer: (promise: Promise<void>) => void,
): void {
  defer(
    namespace
      .getByName(roomId)
      .fetch('https://room-coordinator/poke', {
        method: 'POST',
        headers: { 'x-room-id': roomId },
      })
      .then(() => {
        return undefined
      })
      .catch(() => {
        return undefined
      }),
  )
}
