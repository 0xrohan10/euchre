import { SUITS, hasNaturalTrump, legalCards, trickWinner } from './card'
import { createGame, deal, farmersHandRank } from './deal'
import { next, nextActive, teamOf } from './player'
import type { GameAction, GameState } from './state'

function beginPlay(state: GameState): GameState {
  return {
    ...state,
    phase: 'playing',
    activePlayer: nextActive(state.dealer, state.lonePlayer),
    notice:
      state.lonePlayer === null
        ? `${state.trump} are trump.`
        : `Player ${state.lonePlayer + 1} is going alone.`,
  }
}

function scoreHand(state: GameState): GameState {
  if (state.maker === null) {
    throw new Error('Cannot score a hand without a maker.')
  }
  const makerTeam = teamOf(state.maker)
  const made = state.tricks[makerTeam]
  const points = made < 3 ? 2 : made === 5 ? (state.lonePlayer === null ? 2 : 4) : 1
  const scoringTeam = made < 3 ? ((1 - makerTeam) as 0 | 1) : makerTeam
  const score: [number, number] = [...state.score]
  score[scoringTeam] += points
  const matchOver = score[scoringTeam] >= 10
  const result =
    made < 3
      ? `Team ${makerTeam + 1} was euchred.`
      : made === 5
        ? 'A march!'
        : `Team ${makerTeam + 1} made their bid.`
  return {
    ...state,
    score,
    phase: matchOver ? 'match-over' : 'hand-over',
    notice: `${result} Team ${scoringTeam + 1} scores ${points}.`,
  }
}

export function reduceGame(state: GameState, action: GameAction): GameState {
  if (action.type === 'set-rule') {
    return { ...state, rules: { ...state.rules, [action.rule]: action.enabled } }
  }
  if (action.type === 'new-match') {
    return createGame(undefined, state.rules)
  }
  if (action.type === 'next-hand' && state.phase === 'hand-over') {
    return deal(next(state.dealer), state.score, state.handNumber + 1, state.rules)
  }
  if (action.type === 'collect-trick' && state.phase === 'trick-complete') {
    const collected = { ...state, phase: 'playing' as const, trick: [] }
    return state.tricks[0] + state.tricks[1] === 5 ? scoreHand(collected) : collected
  }

  if (action.type === 'decline-exchange' && state.phase === 'exchanging') {
    return {
      ...state,
      phase: 'ordering',
      activePlayer: next(state.dealer),
      notice: `${state.upCard.rank} of ${state.upCard.suit} is turned up.`,
    }
  }

  if (action.type === 'exchange-kitty' && state.phase === 'exchanging') {
    const rank = farmersHandRank(state.hands[state.activePlayer])
    if (rank === null || state.kitty.length !== 4) {
      return state
    }
    const hand = state.hands[state.activePlayer]
    const exchanged = hand
      .filter((card) => {
        return card.rank === rank
      })
      .slice(0, 3)
    const exchangedIds = new Set(
      exchanged.map((card) => {
        return card.id
      }),
    )
    const hands = state.hands.map((cards) => {
      return [...cards]
    }) as GameState['hands']
    hands[state.activePlayer] = [
      ...hand.filter((card) => {
        return !exchangedIds.has(card.id)
      }),
      ...state.kitty.slice(1),
    ]
    return {
      ...state,
      phase: 'ordering',
      activePlayer: next(state.dealer),
      hands,
      kitty: [state.upCard, ...exchanged],
      exchangedPlayer: state.activePlayer,
      notice: `Player ${state.activePlayer + 1} exchanges a farmer's hand.`,
    }
  }

  if (action.type === 'pass' && (state.phase === 'ordering' || state.phase === 'calling')) {
    if (state.phase === 'calling' && state.activePlayer === state.dealer) {
      if (!state.rules.stickDealer) {
        return deal(next(state.dealer), state.score, state.handNumber, state.rules)
      }
      const canCall = SUITS.some((suit) => {
        return (
          suit !== state.upCard.suit &&
          (!state.rules.requireNaturalTrump || hasNaturalTrump(state.hands[state.dealer], suit))
        )
      })
      return canCall ? state : deal(next(state.dealer), state.score, state.handNumber, state.rules)
    }
    const nextPlayer = next(state.activePlayer)
    if (nextPlayer === next(state.dealer)) {
      if (state.phase === 'ordering') {
        return {
          ...state,
          phase: 'calling',
          activePlayer: next(state.dealer),
          notice: 'Choose any suit except the turned-down suit.',
        }
      }
    }
    return {
      ...state,
      activePlayer: nextPlayer,
      notice: `Player ${state.activePlayer + 1} passes.`,
    }
  }

  if (action.type === 'order-up' && state.phase === 'ordering') {
    if (state.exchangedPlayer === state.activePlayer) {
      return state
    }
    const trump = state.upCard.suit
    if (
      state.rules.requireNaturalTrump &&
      !hasNaturalTrump(state.hands[state.activePlayer], trump)
    ) {
      return state
    }
    const orderingPartner =
      state.activePlayer !== state.dealer && teamOf(state.activePlayer) === teamOf(state.dealer)
    const mayGoAlone = !orderingPartner || state.rules.allowAloneWhenOrderingPartner
    const lonePlayer = action.alone && mayGoAlone ? state.activePlayer : null
    const hands: GameState['hands'] = state.hands.map((hand) => {
      return [...hand]
    }) as GameState['hands']
    hands[state.dealer].push(state.upCard)
    return {
      ...state,
      hands,
      trump,
      maker: state.activePlayer,
      lonePlayer,
      phase: 'discarding',
      activePlayer: state.dealer,
      notice: 'Dealer must discard.',
    }
  }

  if (
    action.type === 'call-trump' &&
    state.phase === 'calling' &&
    action.suit !== state.upCard.suit &&
    (state.exchangedPlayer !== state.activePlayer ||
      (state.rules.stickDealer && state.activePlayer === state.dealer)) &&
    (!state.rules.requireNaturalTrump ||
      hasNaturalTrump(state.hands[state.activePlayer], action.suit))
  ) {
    return beginPlay({
      ...state,
      trump: action.suit,
      maker: state.activePlayer,
      lonePlayer: action.alone ? state.activePlayer : null,
    })
  }

  if (action.type === 'discard' && state.phase === 'discarding' && state.trump !== null) {
    const hand = state.hands[state.dealer]
    if (
      !hand.some((card) => {
        return card.id === action.cardId
      })
    ) {
      return state
    }
    const hands = state.hands.map((cards) => {
      return [...cards]
    }) as GameState['hands']
    hands[state.dealer] = hand.filter((card) => {
      return card.id !== action.cardId
    })
    return beginPlay({ ...state, hands })
  }

  if (action.type === 'play' && state.phase === 'playing' && state.trump !== null) {
    const hand = state.hands[state.activePlayer]
    const card = hand.find((candidate) => {
      return candidate.id === action.cardId
    })
    if (
      !card ||
      !legalCards(hand, state.trick, state.trump).some((legal) => {
        return legal.id === card.id
      })
    ) {
      return state
    }
    const hands = state.hands.map((cards) => {
      return [...cards]
    }) as GameState['hands']
    hands[state.activePlayer] = hand.filter((candidate) => {
      return candidate.id !== card.id
    })
    const trick = [...state.trick, { card, player: state.activePlayer }]
    const cardsNeeded = state.lonePlayer === null ? 4 : 3
    if (trick.length < cardsNeeded) {
      return {
        ...state,
        hands,
        trick,
        activePlayer: nextActive(state.activePlayer, state.lonePlayer),
      }
    }

    const winner = trickWinner(trick, state.trump)
    const tricks: [number, number] = [...state.tricks]
    const playerTricks: [number, number, number, number] = [...state.playerTricks]
    tricks[teamOf(winner)] += 1
    playerTricks[winner] += 1
    return {
      ...state,
      phase: 'trick-complete',
      hands,
      trick,
      tricks,
      playerTricks,
      activePlayer: winner,
      lastTrickWinner: winner,
      notice: `Player ${winner + 1} takes the trick.`,
    }
  }

  return state
}
