import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth-client'
import { hasNaturalTrump, legalCards, sortHand, SUITS, type Card } from '../game/card'
import { teamOf, type Player } from '../game/player'
import type { GameAction } from '../game/state'
import {
  canPassCalling,
  optimisticRoomAction,
  playerAt,
  relativePlayer,
  type RoomView,
} from '../multiplayer'
import {
  confirmRematchFn,
  getRoomFn,
  leavePartyFn,
  leaveRoomFn,
  submitCommandFn,
  voteForBotFn,
} from '../server/game.functions'
import { Brand } from './Brand'
import { CardFace } from './CardFace'
import { FarmerExchange } from './FarmerExchange'
import { FiveScore } from './FiveScore'
import { HiddenHand } from './HiddenHand'
import { HowToPlay } from './HowToPlay'
import { PlayerBadge } from './PlayerBadge'
import { SEAT_ORDER, seatsByNumber } from './seats'
import { SUIT_SYMBOL } from './suit-symbol'

export function GameTable({
  room,
  onRoom,
  onLeave,
}: {
  room: RoomView
  onRoom: (room: RoomView) => void
  onLeave: (leftParty?: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [alone, setAlone] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const game = room.game!
  const partyGame = room.partyId !== null
  const singlePlayer =
    !partyGame &&
    room.seats.some((seat) => {
      return seat.userId === null
    })
  const viewer = room.viewerSeat
  const seats = seatsByNumber(room.seats)
  const viewerSeat = seats.get(viewer)
  const viewerTeam = teamOf(viewer)
  const opponentTeam = (1 - viewerTeam) as 0 | 1
  const isTurn = !pending && room.status === 'playing' && game.activePlayer === viewer
  const hand = sortHand(game.hand, game.trump)
  const legal =
    game.phase === 'playing' && game.trump
      ? new Set(
          legalCards(game.hand, game.trick, game.trump).map((card) => {
            return card.id
          }),
        )
      : new Set<string>()
  const previousGame = useRef(game)
  const exchangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [farmerExchange, setFarmerExchange] = useState<{
    cards: Card[]
    player: Player
    retainedIds: string[]
  } | null>(null)

  useLayoutEffect(() => {
    const previous = previousGame.current
    previousGame.current = game
    if (
      previous.phase !== 'exchanging' ||
      game.exchangedPlayer === null ||
      previous.exchangedPlayer === game.exchangedPlayer
    ) {
      return
    }

    const player = relativePlayer(game.exchangedPlayer, viewer)
    const cards =
      game.exchangedPlayer === viewer
        ? previous.hand
            .filter((card) => {
              return card.rank === '9' || card.rank === '10'
            })
            .filter((card, _, lowCards) => {
              return (
                lowCards.filter(({ rank }) => {
                  return rank === card.rank
                }).length === 3
              )
            })
        : []
    const exchangedIds = new Set(
      cards.map((card) => {
        return card.id
      }),
    )
    setFarmerExchange({
      cards,
      player,
      retainedIds: previous.hand
        .filter((card) => {
          return !exchangedIds.has(card.id)
        })
        .map((card) => {
          return card.id
        }),
    })
    if (exchangeTimer.current) {
      clearTimeout(exchangeTimer.current)
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    exchangeTimer.current = setTimeout(
      () => {
        return setFarmerExchange(null)
      },
      reducedMotion ? 220 : 560,
    )
  }, [game, viewer])

  useEffect(() => {
    return () => {
      if (exchangeTimer.current) {
        clearTimeout(exchangeTimer.current)
      }
    }
  }, [])

  async function act(action: GameAction) {
    setPending(true)
    setError('')
    onRoom(optimisticRoomAction(room, action))
    try {
      const next = await submitCommandFn({
        data: {
          roomId: room.id,
          commandId: crypto.randomUUID(),
          expectedVersion: room.version,
          action,
        },
      })
      onRoom(next)
      setAlone(false)
    } catch {
      setError('The table changed before that action. Your view was refreshed.')
      try {
        onRoom(await getRoomFn({ data: { roomId: room.id } }))
      } catch {
        /* The SSE connection remains the fallback. */
      }
    } finally {
      setPending(false)
    }
  }

  async function leave() {
    setPending(true)
    setError('')
    try {
      if (partyGame) {
        await leavePartyFn()
      } else {
        await leaveRoomFn({ data: { roomId: room.id } })
      }
      onLeave(partyGame)
    } catch {
      setError('Could not leave this game.')
      setConfirmLeave(false)
    } finally {
      setPending(false)
    }
  }

  async function returnToParty() {
    setPending(true)
    setError('')
    try {
      await leaveRoomFn({ data: { roomId: room.id } })
      onLeave(false)
    } catch {
      setError('Could not return to the partnership lobby.')
    } finally {
      setPending(false)
    }
  }

  async function confirmRematch() {
    setPending(true)
    setError('')
    try {
      onRoom(await confirmRematchFn({ data: { roomId: room.id } }))
    } catch {
      setError('Could not confirm the rematch.')
    } finally {
      setPending(false)
    }
  }

  const controls =
    isTurn && (game.phase === 'exchanging' || game.phase === 'ordering' || game.phase === 'calling')
  const availableSuits = SUITS.filter((suit) => {
    return (
      game.phase === 'calling' &&
      suit !== game.upCard.suit &&
      (!game.rules.requireNaturalTrump || hasNaturalTrump(game.hand, suit))
    )
  })
  const exchangeRestricted =
    game.exchangedPlayer === viewer &&
    !(game.phase === 'calling' && game.rules.stickDealer && viewer === game.dealer)
  const handStatus = (
    <div className="hand-turn-status">
      <div className="hand-turn-label">
        <i className={`status-light ${isTurn ? 'your-turn' : ''}`} />
        <span className="eyebrow">
          {room.status === 'paused' ? 'Game paused' : isTurn ? 'Your turn' : 'At the table'}
        </span>
      </div>
      <strong>{error || game.notice}</strong>
    </div>
  )
  const bidControls = controls && (
    <div className="bid-controls">
      {game.phase === 'exchanging' ? (
        <>
          <button
            className="primary-button"
            onClick={() => {
              return void act({ type: 'exchange-kitty' })
            }}
          >
            Swap with kitty
          </button>
          <button
            className="quiet-button"
            onClick={() => {
              return void act({ type: 'decline-exchange' })
            }}
          >
            Keep hand
          </button>
        </>
      ) : game.phase === 'ordering' ? (
        <>
          <button
            className="primary-button"
            disabled={
              exchangeRestricted ||
              (game.rules.requireNaturalTrump && !hasNaturalTrump(game.hand, game.upCard.suit))
            }
            onClick={() => {
              return void act({ type: 'order-up', alone })
            }}
          >
            Order up
          </button>
          <button
            className="quiet-button"
            onClick={() => {
              return void act({ type: 'pass' })
            }}
          >
            Pass
          </button>
        </>
      ) : (
        <>
          <div className="suit-buttons">
            {availableSuits.map((suit) => {
              return (
                <button
                  disabled={exchangeRestricted}
                  className={suit === 'hearts' || suit === 'diamonds' ? 'red' : ''}
                  key={suit}
                  onClick={() => {
                    return void act({ type: 'call-trump', suit, alone })
                  }}
                  aria-label={`Call ${suit}`}
                >
                  {SUIT_SYMBOL[suit]}
                </button>
              )
            })}
          </div>
          {canPassCalling(
            game.rules.stickDealer,
            game.activePlayer === game.dealer,
            availableSuits.length,
          ) && (
            <button
              className="quiet-button"
              onClick={() => {
                return void act({ type: 'pass' })
              }}
            >
              Pass
            </button>
          )}
        </>
      )}
      {game.phase !== 'exchanging' && (
        <label className="alone-toggle">
          <input
            type="checkbox"
            checked={alone}
            disabled={exchangeRestricted}
            onChange={(event) => {
              return setAlone(event.target.checked)
            }}
          />
          Go alone
        </label>
      )}
    </div>
  )
  return (
    <div className="game-shell">
      <header className="app-header">
        <Brand />
        <div className="room-meta">
          <span className="eyebrow">
            {singlePlayer ? 'Single player' : partyGame ? 'Partners vs bots' : 'Table'}
          </span>
          {!singlePlayer && !partyGame && (
            <button
              className="room-code"
              onClick={() => {
                return void navigator.clipboard.writeText(
                  `${window.location.origin}/games/${room.code}`,
                )
              }}
            >
              {room.code}
            </button>
          )}
        </div>
        <div className="header-actions">
          <HowToPlay />
          {(singlePlayer || partyGame) && (
            <button
              className="quiet-button"
              onClick={() => {
                return setConfirmLeave(true)
              }}
            >
              {partyGame ? 'Leave partnership' : 'Leave game'}
            </button>
          )}
          <button
            className="quiet-button"
            onClick={() => {
              return void authClient.signOut().then(() => {
                return window.location.reload()
              })
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="match-layout">
        <aside className="score-panel">
          <div className="score-heading">
            <div>
              <span className="eyebrow">Match to 10</span>
              <h1>Score</h1>
            </div>
            <span className="hand-count">Hand {game.handNumber}</span>
          </div>
          <FiveScore score={game.score[0]} team={0} isViewer={viewerTeam === 0} />
          <FiveScore score={game.score[1]} team={1} isViewer={viewerTeam === 1} />
          <div className="hand-status">
            <span>Tricks</span>
            <strong>
              {game.tricks[viewerTeam]}–{game.tricks[opponentTeam]}
            </strong>
          </div>
        </aside>
        <main className="table-wrap">
          <section className="felt-table">
            {farmerExchange && (
              <FarmerExchange cards={farmerExchange.cards} player={farmerExchange.player} />
            )}
            {(SEAT_ORDER as readonly Player[]).map((relative) => {
              const player = playerAt(viewer, relative)
              const occupant = seats.get(player)
              const position = ['south', 'west', 'north', 'east'][relative]
              const badge = (
                <PlayerBadge
                  occupant={occupant}
                  active={game.activePlayer === player}
                  dealer={game.dealer === player}
                  maker={game.maker === player}
                  lone={game.lonePlayer === player}
                  tricks={game.playerTricks[player]}
                />
              )
              return (
                <div className={`seat seat-${position}`} key={player}>
                  {relative === 0 ? (
                    <>
                      <div className="hand-zone">
                        {handStatus}
                        <div className="human-hand">
                          {hand.map((card) => {
                            const playable =
                              isTurn && (game.phase === 'discarding' || legal.has(card.id))
                            const arrivingFromKitty =
                              farmerExchange?.player === 0 &&
                              !farmerExchange.retainedIds.includes(card.id)
                            return (
                              <CardFace
                                key={card.id}
                                card={card}
                                playable={playable}
                                dimmed={isTurn && !playable}
                                motionClass={arrivingFromKitty ? 'farmer-card-received' : ''}
                                onClick={() => {
                                  return void act({
                                    type: game.phase === 'discarding' ? 'discard' : 'play',
                                    cardId: card.id,
                                  })
                                }}
                              />
                            )
                          })}
                        </div>
                      </div>
                      <div className={`player-console ${controls ? 'has-controls' : ''}`}>
                        {badge}
                        {bidControls}
                      </div>
                    </>
                  ) : (
                    <>
                      {badge}
                      <HiddenHand count={game.handCounts[player]} />
                    </>
                  )}
                </div>
              )
            })}
            <div className="table-center">
              {game.trump && (
                <div
                  className={`trump-chip ${game.trump === 'hearts' || game.trump === 'diamonds' ? 'red' : ''}`}
                >
                  <span>{SUIT_SYMBOL[game.trump]}</span> trump
                </div>
              )}
              <div className="trick-area">
                {game.trick.map((played) => {
                  return (
                    <div
                      key={played.card.id}
                      className={`trick-card trick-player-${relativePlayer(played.player, viewer)}`}
                    >
                      <CardFace card={played.card} />
                    </div>
                  )
                })}
                {game.trick.length === 0 &&
                  (game.phase === 'exchanging' || game.phase === 'ordering') && (
                    <div className="up-card">
                      <CardFace card={game.upCard} />
                    </div>
                  )}
              </div>
            </div>
            {!room.disconnectVote &&
              (game.phase === 'hand-over' || game.phase === 'match-over') && (
                <div className="table-result-scrim">
                  <section
                    className="result-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="result-title"
                  >
                    <span className="eyebrow">
                      {game.phase === 'match-over' ? 'Match complete' : 'Hand complete'}
                    </span>
                    <h2 id="result-title">{game.notice}</h2>
                    <div className="result-actions">
                      {game.phase === 'match-over' && room.rematch ? (
                        <>
                          {room.seats.filter((seat) => {
                            return seat.userId !== null
                          }).length === 2 ? (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={pending || room.rematch.confirmations.includes(viewer)}
                              onClick={() => {
                                return void confirmRematch()
                              }}
                            >
                              {room.rematch.confirmations.includes(viewer)
                                ? 'Rematch confirmed'
                                : 'Confirm rematch'}
                            </button>
                          ) : (
                            <p>Your partner left. Return to the lobby to invite someone new.</p>
                          )}
                          <p>
                            {room.rematch.confirmations.length} of{' '}
                            {room.rematch.requiredConfirmations} confirmed
                          </p>
                          <button
                            type="button"
                            className="quiet-button"
                            disabled={pending}
                            onClick={() => {
                              return void returnToParty()
                            }}
                          >
                            Return to lobby
                          </button>
                        </>
                      ) : room.hostUserId === viewerSeat?.userId ? (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => {
                            return void act({
                              type: game.phase === 'hand-over' ? 'next-hand' : 'new-match',
                            })
                          }}
                        >
                          {game.phase === 'hand-over' ? 'Next hand' : 'Play again'}
                        </button>
                      ) : (
                        <p>Waiting for the host to continue.</p>
                      )}
                    </div>
                  </section>
                </div>
              )}
          </section>
        </main>
      </div>
      {room.disconnectVote && (
        <div className="settings-scrim">
          <section className="settings-panel">
            <div className="settings-header">
              <div>
                <span className="eyebrow">Unanimous decision</span>
                <h2>{seats.get(room.disconnectVote?.disconnectedSeat ?? -1)?.name} disconnected</h2>
              </div>
            </div>
            <div className="settings-section">
              <p>
                Every connected human player must approve bot takeover. The player can reclaim their
                seat whenever they return.
              </p>
              <button
                className="primary-button"
                onClick={() => {
                  return void voteForBotFn({
                    data: {
                      roomId: room.id,
                      disconnectedSeat: room.disconnectVote!.disconnectedSeat,
                      approve: true,
                    },
                  }).then(onRoom)
                }}
              >
                Approve bot takeover
              </button>
              <button
                className="quiet-button"
                onClick={() => {
                  return void voteForBotFn({
                    data: {
                      roomId: room.id,
                      disconnectedSeat: room.disconnectVote!.disconnectedSeat,
                      approve: false,
                    },
                  }).then(onRoom)
                }}
              >
                Keep waiting
              </button>
              <p>
                {room.disconnectVote.approvals.length} of {room.disconnectVote.requiredApprovals}{' '}
                approvals
              </p>
            </div>
          </section>
        </div>
      )}
      {confirmLeave && (
        <div className="settings-scrim">
          <section
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-game-title"
          >
            <div className="settings-header">
              <div>
                <span className="eyebrow">{partyGame ? 'Partnership' : 'Single player'}</span>
                <h2 id="leave-game-title">
                  {partyGame ? 'Leave your partnership?' : 'Leave this game?'}
                </h2>
              </div>
            </div>
            <div className="settings-section">
              <p>
                {partyGame
                  ? 'A bot will finish your seat. Your partner will become the party creator and can invite someone new.'
                  : 'This match will be abandoned and cannot be resumed.'}
              </p>
              <div className="dialog-actions">
                <button
                  className="quiet-button"
                  disabled={pending}
                  onClick={() => {
                    return setConfirmLeave(false)
                  }}
                >
                  Keep playing
                </button>
                <button
                  className="primary-button"
                  disabled={pending}
                  onClick={() => {
                    return void leave()
                  }}
                >
                  {pending ? 'Leaving…' : partyGame ? 'Leave partnership' : 'Leave game'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
