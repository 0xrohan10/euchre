import type { PlayedCard } from '../game/card'
import { CardFace } from './CardFace'

export function WonTricksDialog({
  name,
  trickCount,
  tricks,
  onClose,
}: {
  name: string
  trickCount: number
  tricks: readonly PlayedCard[][]
  onClose: () => void
}) {
  return (
    <div
      className="settings-scrim"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose()
        }
      }}
    >
      <section
        className="settings-panel won-tricks-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="won-tricks-title"
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <div className="settings-header">
          <div>
            <span className="eyebrow">Tricks won</span>
            <h2 id="won-tricks-title">{name}</h2>
          </div>
          <button type="button" className="quiet-button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="won-tricks-list">
          {Array.from({ length: trickCount }, (_, index) => {
            const trick = tricks[index]
            return (
              <div className="won-trick-row" key={index}>
                <span className="won-trick-label">Trick {index + 1}</span>
                {trick ? (
                  <div className="won-trick-cards">
                    {trick.map((played) => {
                      return <CardFace card={played.card} key={played.card.id} />
                    })}
                  </div>
                ) : (
                  <p className="won-trick-unavailable">Card details unavailable</p>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
