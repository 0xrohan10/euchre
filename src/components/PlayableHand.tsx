import { useEffect, useRef, useState } from 'react'
import { CardFace } from './CardFace'
import { effectiveSuit, sameColorSuit, type Card, type Suit } from '../game/card'
import { SUIT_SYMBOL } from './suit-symbol'

export type PlayableHandProps = {
  cards: readonly Card[]
  action: 'play' | 'discard' | null
  legalCardIds: ReadonlySet<string> | readonly string[]
  disabled?: boolean
  untrusted?: boolean
  pending?: boolean
  trump?: Suit | null
  leadSuit?: Suit | null
  receivedCardIds?: ReadonlySet<string> | readonly string[]
  onConfirm: (card: Card) => void | Promise<void>
}

const suitNames: Record<Suit, string> = {
  clubs: 'clubs',
  diamonds: 'diamonds',
  hearts: 'hearts',
  spades: 'spades',
}

function cardName(card: Card) {
  return `${card.rank} of ${suitNames[card.suit]}`
}

function contextLabels(
  card: Card,
  trump: Suit | null | undefined,
  leadSuit: Suit | null | undefined,
) {
  const labels: string[] = []
  if (trump) {
    if (card.rank === 'J' && card.suit === trump) {
      labels.push('Right bower', 'Trump')
    } else if (card.rank === 'J' && card.suit === sameColorSuit(trump)) {
      labels.push('Left bower', `Counts as ${suitNames[trump]}`, 'Trump')
    } else if (effectiveSuit(card, trump) === trump) {
      labels.push('Trump')
    }
  }
  if (leadSuit) {
    const displaySuit = trump ? effectiveSuit(card, trump) : card.suit
    labels.push(
      displaySuit === leadSuit
        ? `Follows ${suitNames[leadSuit]}`
        : `Off-suit from ${suitNames[leadSuit]}`,
    )
  }
  return labels
}

function hasLegalId(legalCardIds: PlayableHandProps['legalCardIds'], id: string) {
  if (Array.isArray(legalCardIds)) {
    return legalCardIds.includes(id)
  }
  return (legalCardIds as ReadonlySet<string>).has(id)
}

export function PlayableHand({
  cards,
  action,
  legalCardIds,
  disabled = false,
  untrusted = false,
  pending = false,
  trump = null,
  leadSuit = null,
  receivedCardIds = [],
  onConfirm,
}: PlayableHandProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  const previousAction = useRef(action)
  const controlsDisabled = disabled || untrusted || pending || confirming || action === null
  const selectedCard =
    cards.find((card) => {
      return card.id === selectedId
    }) ?? null
  const selectedIsLegal = selectedCard !== null && hasLegalId(legalCardIds, selectedCard.id)
  const canConfirm = !controlsDisabled && selectedIsLegal

  useEffect(() => {
    const actionChanged = previousAction.current !== action
    previousAction.current = action
    if (
      actionChanged ||
      controlsDisabled ||
      !selectedCard ||
      !hasLegalId(legalCardIds, selectedCard.id)
    ) {
      setSelectedId(null)
    }
  }, [action, controlsDisabled, legalCardIds, selectedCard])

  function select(card: Card) {
    if (controlsDisabled || !hasLegalId(legalCardIds, card.id)) {
      return
    }
    setSelectedId(card.id)
  }

  function confirm() {
    if (confirmingRef.current) {
      return
    }
    const card =
      cards.find((candidate) => {
        return candidate.id === selectedId
      }) ?? null
    if (controlsDisabled || !card || action === null || !hasLegalId(legalCardIds, card.id)) {
      setSelectedId(null)
      return
    }
    confirmingRef.current = true
    setConfirming(true)
    setSelectedId(null)
    try {
      const result = onConfirm(card)
      const clearConfirming = () => {
        confirmingRef.current = false
        setConfirming(false)
      }
      if (result && typeof result.then === 'function') {
        result.then(clearConfirming, clearConfirming)
      } else {
        clearConfirming()
      }
    } catch (error) {
      confirmingRef.current = false
      setConfirming(false)
      throw error
    }
  }

  const actionLabel = action === 'discard' ? 'Discard' : 'Play'
  return (
    <section className="playable-hand" aria-label="Your hand">
      <div className="playable-hand-cards" role="group" aria-label="Cards in hand">
        {cards.map((card) => {
          const legal = action === null || hasLegalId(legalCardIds, card.id)
          const labels = contextLabels(card, trump, leadSuit)
          const status = action === null ? '' : legal ? 'Legal card.' : `Not legal to ${action}.`
          const label = `${cardName(card)}. ${labels.join('. ')}${labels.length ? '. ' : ''}${status}`
          return (
            <button
              key={card.id}
              type="button"
              className="playable-hand-card"
              aria-label={label}
              aria-pressed={selectedId === card.id}
              disabled={controlsDisabled || !legal}
              onClick={() => {
                select(card)
              }}
            >
              <CardFace
                card={card}
                priority
                playable={action !== null && legal}
                dimmed={action !== null && !legal}
                motionClass={hasLegalId(receivedCardIds, card.id) ? 'farmer-card-received' : ''}
                className="playable-hand-card-face"
              />
              <span className="playable-hand-card-label" aria-hidden="true">
                {labels[0] ?? `${card.rank}${SUIT_SYMBOL[card.suit]}`}
              </span>
            </button>
          )
        })}
      </div>
      {action !== null && (
        <button
          type="button"
          className="playable-hand-confirm"
          disabled={!canConfirm}
          onClick={confirm}
        >
          {selectedCard
            ? `${actionLabel} ${cardName(selectedCard)}`
            : `${actionLabel} selected card`}
        </button>
      )}
      <p className="playable-hand-status" aria-live="polite">
        {pending
          ? 'Waiting for the table…'
          : untrusted
            ? 'Connection is not trusted; actions are paused.'
            : selectedCard
              ? `${cardName(selectedCard)} selected.`
              : ''}
      </p>
    </section>
  )
}
