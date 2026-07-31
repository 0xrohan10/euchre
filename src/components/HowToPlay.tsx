import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function HowToPlay({ label = 'Rules' }: { label?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <>
      <button
        className="quiet-button"
        type="button"
        onClick={() => {
          return dialogRef.current?.showModal()
        }}
      >
        {label}
      </button>
      {mounted &&
        createPortal(
          <dialog
            className="rules-dialog"
            ref={dialogRef}
            aria-labelledby="how-to-play-title"
            aria-describedby="how-to-play-summary"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                event.currentTarget.close()
              }
            }}
          >
            <div className="rules-panel">
              <header className="rules-header">
                <div>
                  <span className="eyebrow">Euchre in five minutes</span>
                  <h2 id="how-to-play-title">How to play</h2>
                </div>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => {
                    return dialogRef.current?.close()
                  }}
                >
                  Close
                </button>
              </header>
              <div className="rules-content">
                <p className="rules-intro" id="how-to-play-summary">
                  Win tricks with your partner, call trump wisely, and be the first team to score 10
                  points.
                </p>
                <div className="rules-grid">
                  <section className="rule-step">
                    <span>1</span>
                    <div>
                      <h3>Teams and cards</h3>
                      <p>
                        Four players form two teams, with partners seated across from each other.
                        The deck has 24 cards: 9, 10, jack, queen, king, and ace in each suit.
                        Everyone gets five cards.
                      </p>
                    </div>
                  </section>
                  <section className="rule-step">
                    <span>2</span>
                    <div>
                      <h3>Choose trump</h3>
                      <p>
                        A card is turned up. Starting left of the dealer, players may order up its
                        suit or pass. If everyone passes, players call any other suit. The dealer
                        must call if the choice returns to them.
                      </p>
                    </div>
                  </section>
                  <section className="rule-step">
                    <span>3</span>
                    <div>
                      <h3>Know the bowers</h3>
                      <p>
                        The jack of trump is the highest card, called the right bower. The jack of
                        the same color is the second highest, called the left bower, and counts as
                        trump instead of its printed suit.
                      </p>
                    </div>
                  </section>
                  <section className="rule-step">
                    <span>4</span>
                    <div>
                      <h3>Play five tricks</h3>
                      <p>
                        The player left of the dealer leads. Follow the led suit when you can;
                        otherwise, play any card. Trump beats every non-trump card. The trick winner
                        leads next.
                      </p>
                    </div>
                  </section>
                </div>
                <section className="rules-callout">
                  <div>
                    <span className="eyebrow">Going alone</span>
                    <h3>Leave your partner out for a bigger reward.</h3>
                  </div>
                  <p>
                    When calling trump, you may go alone. Your partner sits out the hand, and taking
                    all five tricks earns 4 points.
                  </p>
                </section>
                <section className="scoring-rules">
                  <div>
                    <span className="eyebrow">Scoring</span>
                    <h3>Make at least three tricks.</h3>
                  </div>
                  <dl>
                    <div>
                      <dt>Makers win 3 or 4 tricks</dt>
                      <dd>1 point</dd>
                    </div>
                    <div>
                      <dt>Makers win all 5 tricks</dt>
                      <dd>2 points</dd>
                    </div>
                    <div>
                      <dt>Lone player wins all 5</dt>
                      <dd>4 points</dd>
                    </div>
                    <div>
                      <dt>Defenders stop the makers</dt>
                      <dd>2 points</dd>
                    </div>
                  </dl>
                </section>
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </>
  )
}
