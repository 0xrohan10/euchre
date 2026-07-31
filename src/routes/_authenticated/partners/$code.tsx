/* oxlint-disable react/only-export-components */
import { createFileRoute } from '@tanstack/react-router'
import { PartyInviteRoute } from '../../../components/InviteRoute'

export const Route = createFileRoute('/_authenticated/partners/$code')({
  component: PartnerRoute,
})

function PartnerRoute() {
  const { code } = Route.useParams()
  return <PartyInviteRoute code={code} />
}
