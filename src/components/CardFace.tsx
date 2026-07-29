import { cardImage } from '../card-assets'
import type { Card } from '../game/card'

export function CardFace({
  card,
  playable = false,
  dimmed = false,
  priority = false,
  motionClass = '',
  onClick,
}: {
  card: Card
  playable?: boolean
  dimmed?: boolean
  priority?: boolean
  motionClass?: string
  onClick?: () => void
}) {
  const className = `playing-card dealt ${playable ? 'playable' : dimmed ? 'invalid' : ''} ${motionClass}`
  const content = (
    <img
      className="card-art"
      src={cardImage(card)}
      alt={`${card.rank} of ${card.suit}`}
      fetchPriority={priority ? 'high' : 'auto'}
    />
  )
  return onClick ? (
    <button className={className} disabled={!playable} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}
