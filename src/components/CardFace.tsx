import { cardImage } from '../card-assets'
import type { Card } from '../game/card'

export function CardFace({
  card,
  playable = false,
  dimmed = false,
  motionClass = '',
  onClick,
}: {
  card: Card
  playable?: boolean
  dimmed?: boolean
  motionClass?: string
  onClick?: () => void
}) {
  const className = `playing-card dealt ${playable ? 'playable' : dimmed ? 'invalid' : ''} ${motionClass}`
  const content = (
    <img className="card-art" src={cardImage(card)} alt={`${card.rank} of ${card.suit}`} />
  )
  return onClick ? (
    <button className={className} disabled={!playable} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}
