import type { SeatView } from '../multiplayer'

export function PlayerBadge({
  occupant,
  active,
  dealer,
  maker = false,
  lone = false,
  showConnection = false,
}: {
  occupant?: SeatView
  active: boolean
  dealer: boolean
  maker?: boolean
  lone?: boolean
  showConnection?: boolean
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
  const status = showConnection
    ? occupant.controller === 'bot'
      ? 'Bot playing'
      : occupant.connected
        ? 'Connected'
        : 'Disconnected'
    : active
      ? occupant.controller === 'bot'
        ? 'Thinking'
        : 'Playing'
      : 'Waiting'
  const rating = occupant.rating === null ? null : occupant.rating.toLocaleString()
  const mode = occupant.ratingMode === 'competitive' ? 'C' : 'A'
  const provisional = occupant.ratingGames < 10 ? ' provisional' : ''
  const detail = rating === null ? status : `${status} | Skill ${mode} ${rating}${provisional}`
  return (
    <div
      className={`player-badge ${active ? 'active' : ''}`}
      title={
        rating === null
          ? undefined
          : `${occupant.ratingMode === 'competitive' ? 'Competitive' : 'Bot-assisted'} skill rating`
      }
    >
      <span className={`avatar avatar-${occupant.seat}`}>
        {occupant.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="player-copy">
        <span className="player-name">
          <strong>{occupant.name}</strong>
          {maker && <em>{lone ? 'Called alone' : 'Called'}</em>}
        </span>
        <span>{detail}</span>
      </span>
      {dealer && <span className="dealer-chip">D</span>}
      {active && <i className="turn-dot" />}
    </div>
  )
}
