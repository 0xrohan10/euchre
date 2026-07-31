import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { playableCardImageUrls } from '../card-assets'
import { warmCardImages, type CardImageSessionCache } from '../card-image-loader'
import {
  gameActionPendingLabel,
  submitIdempotentCommand,
  UnknownCommandOutcomeError,
  type LiveConnectionState,
  withRequestDeadline,
} from '../interaction-feedback'
import { hasNaturalTrump, legalCards, sortHand, SUITS, type Card } from '../game/card'
import { teamName, teamOf, type Player } from '../game/player'
import type { GameAction } from '../game/state'
import {
  canPassCalling,
  normalizeSubmitCommandResult,
  optimisticRoomAction,
  playerAt,
  relativePlayer,
  roomViewWithPendingAction,
  type GameView,
  type PendingRoomView,
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
import { BlockingDialog } from './BlockingDialog'
import { CardFace } from './CardFace'
import { ConnectionStatus } from './ConnectionStatus'
import { CopyInviteButton } from './CopyInviteButton'
import { FarmerExchange } from './FarmerExchange'
import { FiveScore } from './FiveScore'
import { HeaderMenu } from './HeaderMenu'
import { HiddenHand } from './HiddenHand'
import { HowToPlay } from './HowToPlay'
import { PlayerBadge } from './PlayerBadge'
import { SEAT_ORDER, seatsByNumber } from './seats'
import { SUIT_SYMBOL } from './suit-symbol'
import { TrickPile } from './TrickPile'
import { WonTricksDialog } from './WonTricksDialog'

const cardImageSessionCache: CardImageSessionCache = {
  completedUrls: new Set<string>(),
  inFlightUrls: new Set<string>(),
}

type GameOperation =
  | { type: 'command'; label: string }
  | { type: 'leave'; label: 'Leaving game…' }
  | { type: 'return-to-party'; label: 'Returning to partnership…' }
  | { type: 'rematch'; label: 'Confirming rematch…' }
  | { type: 'vote'; label: 'Submitting vote…' }

function collectedTrickCount(game: GameView, player: Player) {
  const faceUpWinner = game.phase === 'trick-complete' ? game.lastTrickWinner : null
  return game.playerTricks[player] - Number(faceUpWinner === player)
}

function resultCopy(game: GameView) {
  if (game.maker === null) {
    return { title: 'Hand complete', description: game.notice }
  }

  const makerTeam = teamOf(game.maker)
  const tricks = game.tricks[makerTeam]
  const scoringTeam = tricks < 3 ? ((1 - makerTeam) as 0 | 1) : makerTeam
  const points = tricks < 3 ? 2 : tricks === 5 ? (game.lonePlayer === null ? 2 : 4) : 1
  const makerName = teamName(makerTeam)
  const scoringName = teamName(scoringTeam)
  const trickLabel = tricks === 1 ? 'trick' : 'tricks'

  const handTitle = tricks < 3 ? 'Euchred' : tricks === 5 ? 'Clean sweep' : 'Hand won'
  const handDescription =
    tricks < 3
      ? `${makerName} won ${tricks} ${trickLabel}, short of the three needed. ${scoringName} scores 2 points.`
      : tricks === 5
        ? `${makerName} won all five tricks and scores ${points} points${game.lonePlayer === null ? '.' : ' for going alone.'}`
        : `${makerName} won ${tricks} tricks and scores 1 point.`

  return game.phase === 'match-over'
    ? {
        title: `${scoringName} wins`,
        description: `${handDescription} Final score: ${game.score[0]} to ${game.score[1]}.`,
      }
    : { title: handTitle, description: handDescription }
}

export function GameTable({
  room: confirmedRoom,
  connection,
  onRoom,
  onLeave,
  onSignOut,
}: {
  room: RoomView
  connection: LiveConnectionState
  onRoom: (room: RoomView) => void
  onLeave: (leftParty?: boolean) => void
  onSignOut: () => void
}) {
  const [operation, setOperation] = useState<GameOperation | null>(null)
  const [pendingRoom, setPendingRoom] = useState<PendingRoomView | null>(null)
  const [error, setError] = useState('')
  const [alone, setAlone] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [viewingTricks, setViewingTricks] = useState<Player | null>(null)
  const room = roomViewWithPendingAction(confirmedRoom, pendingRoom)
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
  const result = resultCopy(game)
  const actionsDisabled = operation !== null || !connection.snapshotTrusted
  const viewerTurn = room.status === 'playing' && game.activePlayer === viewer
  const isTurn = !actionsDisabled && viewerTurn
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
  const roomRef = useRef(room)
  roomRef.current = room
  const exchangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [farmerExchange, setFarmerExchange] = useState<{
    cards: Card[]
    player: Player
    retainedIds: string[]
  } | null>(null)

  useEffect(() => {
    const warmup = warmCardImages({
      priorityUrls: [],
      deferredUrls: playableCardImageUrls,
      sessionCache: cardImageSessionCache,
    })
    return warmup.stop
  }, [])

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
    if (actionsDisabled) {
      return
    }
    setOperation({ type: 'command', label: gameActionPendingLabel(action) })
    setError('')
    const base = roomRef.current
    setPendingRoom({ baseVersion: base.version, room: optimisticRoomAction(base, action) })
    const command = {
      roomId: base.id,
      commandId: crypto.randomUUID(),
      expectedVersion: base.version,
      action,
      responseVersion: 2 as const,
    }
    try {
      const result = normalizeSubmitCommandResult(
        await submitIdempotentCommand(command, (data) => {
          return submitCommandFn({ data })
        }),
      )
      onRoom(result.room)
      setPendingRoom(null)
      if (result.status === 'stale') {
        setError('The table changed before that action. Review the refreshed table and try again.')
      } else {
        setAlone(false)
      }
    } catch (cause) {
      setPendingRoom(null)
      if (cause instanceof UnknownCommandOutcomeError) {
        setError(
          'The action may have completed, but confirmation timed out. Wait for the table to refresh before trying again.',
        )
        return
      }
      setError('That action could not be completed. Review the table and try again.')
      try {
        onRoom(
          await withRequestDeadline(() => {
            return getRoomFn({ data: { roomId: roomRef.current.id } })
          }),
        )
      } catch {
        /* The SSE connection remains the fallback. */
      }
    } finally {
      setOperation(null)
    }
  }

  async function leave() {
    setOperation({ type: 'leave', label: 'Leaving game…' })
    setError('')
    try {
      if (partyGame) {
        await withRequestDeadline(leavePartyFn)
      } else {
        await withRequestDeadline(() => {
          return leaveRoomFn({ data: { roomId: room.id } })
        })
      }
      onLeave(partyGame)
    } catch {
      setError('Could not leave this game. Please try again.')
      setConfirmLeave(false)
    } finally {
      setOperation(null)
    }
  }

  async function returnToParty() {
    setOperation({ type: 'return-to-party', label: 'Returning to partnership…' })
    setError('')
    try {
      await withRequestDeadline(() => {
        return leaveRoomFn({ data: { roomId: room.id } })
      })
      onLeave(false)
    } catch {
      setError('Could not return to the partnership lobby. Please try again.')
    } finally {
      setOperation(null)
    }
  }

  async function confirmRematch() {
    setOperation({ type: 'rematch', label: 'Confirming rematch…' })
    setError('')
    try {
      onRoom(
        await withRequestDeadline(() => {
          return confirmRematchFn({ data: { roomId: room.id } })
        }),
      )
    } catch {
      setError('Could not confirm the rematch. Please try again.')
    } finally {
      setOperation(null)
    }
  }

  async function voteForBot(approve: boolean) {
    if (!room.disconnectVote || actionsDisabled) {
      return
    }
    setOperation({ type: 'vote', label: 'Submitting vote…' })
    setError('')
    try {
      onRoom(
        await withRequestDeadline(() => {
          return voteForBotFn({
            data: {
              roomId: room.id,
              disconnectedSeat: room.disconnectVote!.disconnectedSeat,
              approve,
            },
          })
        }),
      )
    } catch {
      setError('Could not submit your bot takeover vote. Please try again.')
    } finally {
      setOperation(null)
    }
  }

  const controls =
    viewerTurn &&
    (game.phase === 'exchanging' || game.phase === 'ordering' || game.phase === 'calling')
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
  const bidControls = controls && (
    <div className="bid-controls" aria-busy={operation?.type === 'command'}>
      {game.phase === 'exchanging' ? (
        <>
          <button
            className="primary-button"
            disabled={actionsDisabled}
            onClick={() => {
              return void act({ type: 'exchange-kitty' })
            }}
          >
            Swap with kitty
          </button>
          <button
            className="quiet-button"
            disabled={actionsDisabled}
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
              actionsDisabled ||
              exchangeRestricted ||
              (game.rules.requireNaturalTrump && !hasNaturalTrump(game.hand, game.upCard.suit))
            }
            onClick={() => {
              return void act({ type: 'order-up', alone })
            }}
          >
            {viewer === game.dealer ? 'Pick up' : 'Order up'}
          </button>
          <button
            className="quiet-button pass-button"
            disabled={actionsDisabled}
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
                  disabled={actionsDisabled || exchangeRestricted}
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
              className="quiet-button pass-button"
              disabled={actionsDisabled}
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
            disabled={actionsDisabled || exchangeRestricted}
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
            <CopyInviteButton key={room.id} path={`/games/${room.code}`} label={room.code} />
          )}
          <ConnectionStatus connection={connection} />
        </div>
        <HeaderMenu>
          <Link className="quiet-button" to="/history">
            Game history
          </Link>
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
            disabled={operation !== null}
            onClick={() => {
              onSignOut()
            }}
          >
            Sign out
          </button>
        </HeaderMenu>
      </header>
      <div className="match-layout">
        <aside className="score-panel">
          <div className="score-heading">
            <div>
              <span className="eyebrow">Match to 10</span>
              <h1>Score</h1>
            </div>
            <div className="score-heading-meta">
              <span className="hand-count">Hand {game.handNumber}</span>
              <span className="mobile-tricks">
                Tricks {game.tricks[viewerTeam]}–{game.tricks[opponentTeam]}
              </span>
            </div>
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
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {operation?.label ?? ''}
          </span>
          {error && (
            <p className="game-error" role="alert">
              {error}
            </p>
          )}
          <section className="felt-table" aria-busy={operation?.type === 'command'}>
            {farmerExchange && (
              <FarmerExchange cards={farmerExchange.cards} player={farmerExchange.player} />
            )}
            {(SEAT_ORDER as readonly Player[]).map((relative) => {
              const player = playerAt(viewer, relative)
              const occupant = seats.get(player)
              const position = ['south', 'west', 'north', 'east'][relative]
              const teamClass = teamOf(player) === 0 ? 'team-black' : 'team-red'
              const identity = (
                <div className={`player-identity ${teamClass}`}>
                  <PlayerBadge
                    occupant={occupant}
                    active={game.activePlayer === player}
                    dealer={game.dealer === player}
                    maker={game.maker === player}
                    lone={game.lonePlayer === player}
                  />
                  <TrickPile
                    trickCount={collectedTrickCount(game, player)}
                    tricks={game.wonTricks[player]}
                    onOpen={() => {
                      setViewingTricks(player)
                    }}
                  />
                </div>
              )
              return (
                <div className={`seat seat-${position}`} key={player}>
                  {relative === 0 ? (
                    <>
                      {bidControls}
                      <div className="hand-zone">
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
                                priority
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
                      <div className={`player-console ${teamClass}`}>{identity}</div>
                    </>
                  ) : relative === 1 || relative === 3 ? (
                    <>
                      <HiddenHand count={game.handCounts[player]} />
                      {identity}
                    </>
                  ) : (
                    <>
                      {identity}
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
                      <CardFace card={game.upCard} priority />
                    </div>
                  )}
              </div>
            </div>
            {!room.disconnectVote &&
              !confirmLeave &&
              (game.phase === 'hand-over' || game.phase === 'match-over') && (
                <div className="table-result-scrim">
                  <BlockingDialog
                    className="result-dialog"
                    labelledBy="result-title"
                    describedBy="result-description"
                  >
                    <span className="eyebrow">
                      {game.phase === 'match-over' ? 'Match complete' : 'Hand complete'}
                    </span>
                    <h2 id="result-title">{result.title}</h2>
                    <p id="result-description" className="result-description">
                      {result.description}
                    </p>
                    <div
                      className="result-actions"
                      aria-busy={
                        operation?.type === 'command' ||
                        operation?.type === 'rematch' ||
                        operation?.type === 'return-to-party'
                      }
                    >
                      {game.phase === 'match-over' && room.rematch ? (
                        <>
                          {room.seats.filter((seat) => {
                            return seat.userId !== null
                          }).length === 2 ? (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={
                                actionsDisabled || room.rematch.confirmations.includes(viewer)
                              }
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
                            className="quiet-button leave-game-button"
                            disabled={actionsDisabled}
                            onClick={() => {
                              return void returnToParty()
                            }}
                          >
                            Leave game
                          </button>
                        </>
                      ) : (
                        <>
                          {room.hostUserId === viewerSeat?.userId ? (
                            <button
                              type="button"
                              className={
                                game.phase === 'hand-over'
                                  ? 'quiet-button next-hand-button'
                                  : 'primary-button new-game-button'
                              }
                              disabled={actionsDisabled}
                              onClick={() => {
                                return void act({
                                  type: game.phase === 'hand-over' ? 'next-hand' : 'new-match',
                                })
                              }}
                            >
                              {game.phase === 'hand-over' ? 'Next hand' : 'New game'}
                            </button>
                          ) : (
                            <p>Waiting for the host to continue.</p>
                          )}
                          {game.phase === 'match-over' && (
                            <button
                              type="button"
                              className="quiet-button leave-game-button"
                              disabled={actionsDisabled}
                              onClick={() => {
                                return setConfirmLeave(true)
                              }}
                            >
                              Leave game
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </BlockingDialog>
                </div>
              )}
          </section>
        </main>
      </div>
      {viewingTricks !== null &&
        !room.disconnectVote &&
        !confirmLeave &&
        game.phase !== 'hand-over' &&
        game.phase !== 'match-over' && (
          <WonTricksDialog
            name={seats.get(viewingTricks)?.name ?? `Player ${viewingTricks + 1}`}
            trickCount={collectedTrickCount(game, viewingTricks)}
            tricks={game.wonTricks[viewingTricks]}
            onClose={() => {
              setViewingTricks(null)
            }}
          />
        )}
      {room.disconnectVote && (
        <div className="settings-scrim">
          <BlockingDialog
            className="settings-panel"
            labelledBy="disconnect-vote-title"
            describedBy="disconnect-vote-description"
          >
            <div className="settings-header">
              <div>
                <span className="eyebrow">Unanimous decision</span>
                <h2 id="disconnect-vote-title">
                  {seats.get(room.disconnectVote?.disconnectedSeat ?? -1)?.name} disconnected
                </h2>
              </div>
            </div>
            <div className="settings-section" aria-busy={operation?.type === 'vote'}>
              <p id="disconnect-vote-description">
                Every connected human player must approve bot takeover. The player can reclaim their
                seat whenever they return.
              </p>
              <button
                className="primary-button"
                disabled={actionsDisabled}
                onClick={() => {
                  return void voteForBot(true)
                }}
              >
                {operation?.type === 'vote' ? 'Submitting vote…' : 'Approve bot takeover'}
              </button>
              <button
                className="quiet-button"
                disabled={actionsDisabled}
                onClick={() => {
                  return void voteForBot(false)
                }}
              >
                Keep waiting
              </button>
              <p>
                {room.disconnectVote.approvals.length} of {room.disconnectVote.requiredApprovals}{' '}
                approvals
              </p>
            </div>
          </BlockingDialog>
        </div>
      )}
      {confirmLeave && !room.disconnectVote && (
        <div className="settings-scrim">
          <BlockingDialog
            className="settings-panel"
            labelledBy="leave-game-title"
            onEscape={() => {
              if (operation?.type !== 'leave') {
                setConfirmLeave(false)
              }
            }}
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
                  : game.phase === 'match-over'
                    ? 'This match is complete. You’ll return to the lobby.'
                    : 'This match will be abandoned and cannot be resumed.'}
              </p>
              <div className="dialog-actions" aria-busy={operation?.type === 'leave'}>
                <button
                  className="quiet-button"
                  disabled={operation?.type === 'leave'}
                  onClick={() => {
                    return setConfirmLeave(false)
                  }}
                >
                  Keep playing
                </button>
                <button
                  className="primary-button"
                  disabled={actionsDisabled}
                  onClick={() => {
                    return void leave()
                  }}
                >
                  {operation?.type === 'leave'
                    ? 'Leaving…'
                    : partyGame
                      ? 'Leave partnership'
                      : 'Leave game'}
                </button>
              </div>
            </div>
          </BlockingDialog>
        </div>
      )}
    </div>
  )
}
