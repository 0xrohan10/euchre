/* oxlint-disable react/only-export-components */
import { createFileRoute } from '@tanstack/react-router'
import App from '../../App'
import { RoomInviteRoute } from '../../components/InviteRoute'

type HomeSearch = {
  room?: string
}

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => {
    return typeof search.room === 'string' && search.room.length > 0 ? { room: search.room } : {}
  },
  component: HomeRoute,
})

function HomeRoute() {
  const { room } = Route.useSearch()
  return room ? <RoomInviteRoute code={room} /> : <App />
}
