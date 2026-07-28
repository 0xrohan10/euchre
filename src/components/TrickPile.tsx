import type { CSSProperties } from 'react'
import { cardBackImage } from '../card-assets'
import type { PlayedCard } from '../game/card'

export function TrickPile({
  trickCount,
  tricks,
  onOpen,
}: {
  trickCount: number
  tricks: readonly PlayedCard[][]
  onOpen: () => void
}) {
  if (trickCount === 0) {
    return null
  }

  return (
    <button
      type="button"
      className="trick-pile"
      aria-label={`${trickCount} ${trickCount === 1 ? 'trick' : 'tricks'} won. View cards.`}
      onClick={onOpen}
    >
      {Array.from({ length: trickCount }, (_, trickIndex) => {
        const trick =
          tricks[trickIndex] ??
          Array.from({ length: 4 }, () => {
            return null
          })
        return (
          <span className="trick-stack" key={trickIndex}>
            {trick.map((played, cardIndex) => {
              return (
                <img
                  className="trick-pile-card"
                  src={cardBackImage}
                  alt=""
                  key={played?.card.id ?? cardIndex}
                  style={
                    {
                      '--stack-index': cardIndex,
                    } as CSSProperties
                  }
                />
              )
            })}
          </span>
        )
      })}
    </button>
  )
}
