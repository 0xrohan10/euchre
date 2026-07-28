import type { CSSProperties } from 'react'
import { cardBackImage, cardImage } from '../card-assets'
import type { Card } from '../game/card'
import type { Player } from '../game/player'

const SLOT_INDEXES = [0, 1, 2] as const

function exchangeStyle(index: number, delayMs: number): CSSProperties {
  return {
    '--exchange-delay': `${delayMs}ms`,
    '--exchange-fan': `${(index - 1) * 28}px`,
    '--exchange-rotation': `${(index - 1) * 5}deg`,
    '--exchange-stack': `${(index - 1) * 4}px`,
    '--exchange-stack-rotation': `${index - 1}deg`,
  } as CSSProperties
}

export function FarmerExchange({ cards, player }: { cards: Card[]; player: Player }) {
  return (
    <div className={`farmer-exchange exchange-player-${player}`} aria-hidden="true">
      {SLOT_INDEXES.map((index) => {
        return (
          <div
            className="exchange-card exchange-card-out"
            key={`out-${index}`}
            style={exchangeStyle(index, index * 32)}
          >
            <img src={cards[index] ? cardImage(cards[index]) : cardBackImage} alt="" />
          </div>
        )
      })}
      {SLOT_INDEXES.map((index) => {
        return (
          <div
            className="exchange-card exchange-card-in"
            key={`in-${index}`}
            style={exchangeStyle(index, 32 + index * 32)}
          >
            <img src={cardBackImage} alt="" />
          </div>
        )
      })}
    </div>
  )
}
