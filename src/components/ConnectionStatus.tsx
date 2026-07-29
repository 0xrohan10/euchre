import { connectionStatusLabel, type LiveConnectionState } from '../interaction-feedback'

export function ConnectionStatus({ connection }: { connection: LiveConnectionState }) {
  const label = connectionStatusLabel(connection)
  return (
    <span
      className={`connection-status is-${connection.status}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="connection-status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}
