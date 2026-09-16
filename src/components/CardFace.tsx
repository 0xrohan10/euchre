import { cardImage } from '../card-assets'
import type { Card } from '../game/card'

export function CardFace({
  card,
  playable = false,
  dimmed = false,
  priority = false,
  motionClass = '',
  className = '',
  onClick,
}: {
  card: Card
  playable?: boolean
  dimmed?: boolean
  priority?: boolean
  motionClass?: string
  className?: string
  onClick?: () => void
}) {
  const cardClassName = `playing-card dealt ${playable ? 'playable' : dimmed ? 'invalid' : ''} ${motionClass} ${className}`
  const content = (
    <img
      className="card-art"
      src={cardImage(card)}
      alt={`${card.rank} of ${card.suit}`}
      fetchPriority={priority ? 'high' : 'auto'}
    />
  )
  return onClick ? (
    <button className={cardClassName} disabled={!playable} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={cardClassName}>{content}</div>
  )
}
