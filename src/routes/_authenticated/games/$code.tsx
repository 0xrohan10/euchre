/* oxlint-disable react/only-export-components */
import { createFileRoute } from '@tanstack/react-router'
import { RoomInviteRoute } from '../../../components/InviteRoute'

export const Route = createFileRoute('/_authenticated/games/$code')({
  component: GameRoute,
})

function GameRoute() {
  const { code } = Route.useParams()
  return <RoomInviteRoute code={code} />
}
