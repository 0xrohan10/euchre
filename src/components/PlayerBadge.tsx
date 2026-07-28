import type { SeatView } from '../multiplayer'

export function PlayerBadge({
  occupant,
  active,
  dealer,
  maker = false,
  lone = false,
  tricks,
}: {
  occupant?: SeatView
  active: boolean
  dealer: boolean
  maker?: boolean
  lone?: boolean
  tricks?: number
}) {
  if (!occupant) {
    return (
      <div className="player-badge">
        <span className="avatar">?</span>
        <span className="player-copy">
          <strong>Open seat</strong>
          <span>Waiting</span>
        </span>
      </div>
    )
  }
  const trickLabel = tricks === 1 ? '1 trick' : `${tricks ?? 0} tricks`
  const status =
    tricks === undefined
      ? occupant.controller === 'bot'
        ? 'Bot playing'
        : occupant.connected
          ? 'Connected'
          : 'Disconnected'
      : active
        ? `${occupant.controller === 'bot' ? 'Thinking' : 'Playing'} · ${trickLabel}`
        : `${trickLabel} won`
  return (
    <div className={`player-badge ${active ? 'active' : ''}`}>
      <span className={`avatar avatar-${occupant.seat}`}>
        {occupant.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="player-copy">
        <span className="player-name">
          <strong>{occupant.name}</strong>
          {maker && <em>{lone ? 'Called alone' : 'Called'}</em>}
        </span>
        <span>{status}</span>
      </span>
      {dealer && <span className="dealer-chip">D</span>}
      {active && <i className="turn-dot" />}
    </div>
  )
}
