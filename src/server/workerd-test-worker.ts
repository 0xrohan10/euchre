export { LiveStreamAdmissionGate } from './live-stream-admission-do.server'
export { RoomCoordinator } from './room-coordinator-do.server'

export default {
  fetch: () => {
    return new Response('Not found', { status: 404 })
  },
}
