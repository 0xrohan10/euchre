import { chooseBotAction, reduceGame, type Card, type GameAction, type GameRules, type GameState, type Player } from './game'

export type RoomStatus = 'lobby' | 'playing' | 'paused' | 'finished'

export type SeatView = {
  seat: Player
  userId: string | null
  name: string
  controller: 'human' | 'bot'
  connected: boolean
}

export type GameView = Omit<GameState, 'hands' | 'kitty'> & {
  hand: Card[]
  handCounts: [number, number, number, number]
}

export type DisconnectVoteView = {
  disconnectedSeat: Player
  approvals: Player[]
  requiredApprovals: number
}

export type RoomView = {
  id: string
  code: string
  status: RoomStatus
  version: number
  hostUserId: string
  viewerSeat: Player
  rules: GameRules
  seats: SeatView[]
  game: GameView | null
  disconnectVote: DisconnectVoteView | null
}

export type PlayerAction = Extract<GameAction,
  | { type: 'pass' }
  | { type: 'order-up' }
  | { type: 'call-trump' }
  | { type: 'discard' }
  | { type: 'play' }
>

export function projectGame(game: GameState, viewerSeat: Player): GameView {
  const { hands, kitty: _kitty, ...publicGame } = game
  return {
    ...publicGame,
    hand: hands[viewerSeat],
    handCounts: hands.map((hand) => hand.length) as GameView['handCounts'],
  }
}

export function relativePlayer(player: Player, viewerSeat: Player): Player {
  return ((player - viewerSeat + 4) % 4) as Player
}

export function playerAt(viewerSeat: Player, relativeSeat: Player): Player {
  return ((viewerSeat + relativeSeat) % 4) as Player
}

export function statusForGame(game: Pick<GameState, 'phase'>): Extract<RoomStatus, 'playing' | 'finished'> {
  return game.phase === 'match-over' ? 'finished' : 'playing'
}

export function statusForPresence(status: RoomStatus, phase: GameState['phase'] | null, hasDisconnectedHuman: boolean, hostDisconnected: boolean): RoomStatus {
  if (status === 'lobby') return 'lobby'
  if (phase === 'match-over') return hostDisconnected ? 'paused' : 'finished'
  return hasDisconnectedHuman ? 'paused' : 'playing'
}

export function acceptsRoomAction(status: RoomStatus, phase: GameState['phase'], action: GameAction['type']): boolean {
  return action === 'new-match'
    ? status === 'finished' && phase === 'match-over'
    : status === 'playing'
}

export function acceptRoomUpdate(current: RoomView | null, next: RoomView): RoomView {
  return current && current.id === next.id && current.version > next.version ? current : next
}

export function optimisticRoomAction(room: RoomView, action: GameAction): RoomView {
  const game = room.game
  if (!game) return room

  if (action.type === 'next-hand' || action.type === 'new-match' || action.type === 'collect-trick' || action.type === 'set-rule') {
    return { ...room, game: { ...game, notice: 'Updating table...' } }
  }

  if (action.type === 'pass' && game.phase === 'calling' && game.activePlayer === game.dealer) {
    return { ...room, game: { ...game, notice: 'Redealing...' } }
  }

  const { hand, handCounts: currentHandCounts, ...publicGame } = game
  const hands: GameState['hands'] = [[], [], [], []]
  hands[room.viewerSeat] = hand
  const optimisticGame = reduceGame({ ...publicGame, hands, kitty: [] }, action)
  const projected = projectGame(optimisticGame, room.viewerSeat)
  const handCounts = [...currentHandCounts] as GameView['handCounts']

  if (action.type === 'order-up') handCounts[game.dealer] += 1
  if (action.type === 'play' || action.type === 'discard') handCounts[room.viewerSeat] -= 1
  projected.handCounts = handCounts

  return {
    ...room,
    status: statusForGame(optimisticGame),
    game: projected,
  }
}

export function canPassCalling(stickDealer: boolean, isDealer: boolean, callableSuitCount: number): boolean {
  return !stickDealer || !isDealer || callableSuitCount === 0
}

export function advanceBot(game: GameState, seats: readonly { seat: number; controller: 'human' | 'bot' }[]): GameState {
  if (game.phase === 'trick-complete') return game
  const active = seats.find(({ seat }) => seat === game.activePlayer)
  if (active?.controller !== 'bot') return game
  const action = chooseBotAction(game)
  return action ? reduceGame(game, action) : game
}

export function eligibleBotVoters<T extends { seat: number; userId: string | null; connected: boolean; controller: 'human' | 'bot' }>(seats: readonly T[], disconnectedSeat: number): T[] {
  return seats.filter((seat) => seat.seat !== disconnectedSeat && seat.connected && seat.controller === 'human')
}
