export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
export const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'] as const

export type Suit = (typeof SUITS)[number]
export type Rank = (typeof RANKS)[number]
export type Player = 0 | 1 | 2 | 3

export type Card = {
  id: string
  rank: Rank
  suit: Suit
}

export type PlayedCard = { card: Card; player: Player }

export type GameRules = {
  stickDealer: boolean
  requireNaturalTrump: boolean
  allowAloneWhenOrderingPartner: boolean
}

export const DEFAULT_RULES: GameRules = {
  stickDealer: true,
  requireNaturalTrump: true,
  allowAloneWhenOrderingPartner: false,
}

export type GameState = {
  phase: 'ordering' | 'calling' | 'discarding' | 'playing' | 'trick-complete' | 'hand-over' | 'match-over'
  dealer: Player
  activePlayer: Player
  hands: [Card[], Card[], Card[], Card[]]
  kitty: Card[]
  upCard: Card
  trump: Suit | null
  maker: Player | null
  lonePlayer: Player | null
  trick: PlayedCard[]
  tricks: [number, number]
  playerTricks: [number, number, number, number]
  score: [number, number]
  handNumber: number
  lastTrickWinner: Player | null
  notice: string
  rules: GameRules
}

export type GameAction =
  | { type: 'pass' }
  | { type: 'order-up'; alone?: boolean }
  | { type: 'call-trump'; suit: Suit; alone?: boolean }
  | { type: 'discard'; cardId: string }
  | { type: 'play'; cardId: string }
  | { type: 'collect-trick' }
  | { type: 'next-hand' }
  | { type: 'new-match' }
  | { type: 'set-rule'; rule: keyof GameRules; enabled: boolean }

const rankValue: Record<Rank, number> = { '9': 0, '10': 1, J: 2, Q: 3, K: 4, A: 5 }

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${rank}-${suit}`, rank, suit })))
}

export function shuffle<T>(items: readonly T[]): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
  }
  return shuffled
}

function next(player: Player): Player {
  return ((player + 1) % 4) as Player
}

export function teamOf(player: Player): 0 | 1 {
  return (player % 2) as 0 | 1
}

export function sameColorSuit(suit: Suit): Suit {
  if (suit === 'clubs') return 'spades'
  if (suit === 'spades') return 'clubs'
  if (suit === 'diamonds') return 'hearts'
  return 'diamonds'
}

export function effectiveSuit(card: Card, trump: Suit): Suit {
  if (card.rank === 'J' && card.suit === sameColorSuit(trump)) return trump
  return card.suit
}

export function hasNaturalTrump(hand: readonly Card[], trump: Suit): boolean {
  return hand.some((card) => card.suit === trump)
}

function strength(card: Card, lead: Suit, trump: Suit): number {
  if (card.rank === 'J' && card.suit === trump) return 200
  if (card.rank === 'J' && card.suit === sameColorSuit(trump)) return 199
  const suit = effectiveSuit(card, trump)
  if (suit === trump) return 100 + rankValue[card.rank]
  if (suit === lead) return 50 + rankValue[card.rank]
  return rankValue[card.rank]
}

export function legalCards(hand: readonly Card[], trick: readonly PlayedCard[], trump: Suit): Card[] {
  if (trick.length === 0) return [...hand]
  const lead = effectiveSuit(trick[0].card, trump)
  const following = hand.filter((card) => effectiveSuit(card, trump) === lead)
  return following.length > 0 ? following : [...hand]
}

export function trickWinner(trick: readonly PlayedCard[], trump: Suit): Player {
  if (trick.length === 0) throw new Error('Cannot score an empty trick.')
  const lead = effectiveSuit(trick[0].card, trump)
  return trick.reduce((best, played) =>
    strength(played.card, lead, trump) > strength(best.card, lead, trump) ? played : best,
  ).player
}

function nextActive(player: Player, lonePlayer: Player | null): Player {
  const candidate = next(player)
  if (lonePlayer !== null && candidate === ((lonePlayer + 2) % 4)) return next(candidate)
  return candidate
}

function deal(dealer: Player, score: [number, number], handNumber: number, rules: GameRules, deck = shuffle(createDeck())): GameState {
  if (deck.length !== 24) throw new Error('A Euchre deck must contain exactly 24 cards.')
  const hands: [Card[], Card[], Card[], Card[]] = [[], [], [], []]
  let cursor = 0
  for (let round = 0; round < 5; round += 1) {
    for (let offset = 1; offset <= 4; offset += 1) {
      const player = ((dealer + offset) % 4) as Player
      hands[player].push(deck[cursor++])
    }
  }
  const kitty = deck.slice(cursor)
  const upCard = kitty[0]
  return {
    phase: 'ordering', dealer, activePlayer: next(dealer), hands, kitty, upCard,
    trump: null, maker: null, lonePlayer: null, trick: [], tricks: [0, 0], playerTricks: [0, 0, 0, 0], score,
    handNumber, lastTrickWinner: null, notice: `${upCard.rank} of ${upCard.suit} is turned up.`, rules: { ...rules },
  }
}

export function createGame(deck?: Card[], rules: GameRules = DEFAULT_RULES): GameState {
  return deal(3, [0, 0], 1, rules, deck)
}

function beginPlay(state: GameState, notice?: string): GameState {
  return {
    ...state,
    phase: 'playing',
    activePlayer: nextActive(state.dealer, state.lonePlayer),
    notice: notice ?? (state.lonePlayer === null ? `${state.trump} are trump.` : `Player ${state.lonePlayer + 1} is going alone.`),
  }
}

function scoreHand(state: GameState): GameState {
  if (state.maker === null) throw new Error('Cannot score a hand without a maker.')
  const makerTeam = teamOf(state.maker)
  const made = state.tricks[makerTeam]
  const points = made < 3 ? 2 : made === 5 ? (state.lonePlayer === null ? 2 : 4) : 1
  const scoringTeam = made < 3 ? ((1 - makerTeam) as 0 | 1) : makerTeam
  const score: [number, number] = [...state.score]
  score[scoringTeam] += points
  const matchOver = score[scoringTeam] >= 10
  const result = made < 3 ? `Team ${makerTeam + 1} was euchred.` : made === 5 ? 'A march!' : `Team ${makerTeam + 1} made their bid.`
  return { ...state, score, phase: matchOver ? 'match-over' : 'hand-over', notice: `${result} Team ${scoringTeam + 1} scores ${points}.` }
}

export function reduceGame(state: GameState, action: GameAction): GameState {
  if (action.type === 'set-rule') return { ...state, rules: { ...state.rules, [action.rule]: action.enabled } }
  if (action.type === 'new-match') return createGame(undefined, state.rules)
  if (action.type === 'next-hand' && state.phase === 'hand-over') return deal(next(state.dealer), state.score, state.handNumber + 1, state.rules)
  if (action.type === 'collect-trick' && state.phase === 'trick-complete') {
    const collected = { ...state, phase: 'playing' as const, trick: [] }
    return state.tricks[0] + state.tricks[1] === 5 ? scoreHand(collected) : collected
  }

  if (action.type === 'pass' && (state.phase === 'ordering' || state.phase === 'calling')) {
    if (state.phase === 'calling' && state.activePlayer === state.dealer) {
      if (!state.rules.stickDealer) return deal(next(state.dealer), state.score, state.handNumber, state.rules)
      const canCall = SUITS.some((suit) => suit !== state.upCard.suit && (!state.rules.requireNaturalTrump || hasNaturalTrump(state.hands[state.dealer], suit)))
      return canCall ? state : deal(next(state.dealer), state.score, state.handNumber, state.rules)
    }
    const nextPlayer = next(state.activePlayer)
    if (nextPlayer === next(state.dealer)) {
      if (state.phase === 'ordering') {
        return { ...state, phase: 'calling', activePlayer: next(state.dealer), notice: 'Choose any suit except the turned-down suit.' }
      }
    }
    return { ...state, activePlayer: nextPlayer, notice: `Player ${state.activePlayer + 1} passes.` }
  }

  if (action.type === 'order-up' && state.phase === 'ordering') {
    const trump = state.upCard.suit
    if (state.rules.requireNaturalTrump && !hasNaturalTrump(state.hands[state.activePlayer], trump)) return state
    const orderingPartner = state.activePlayer !== state.dealer && teamOf(state.activePlayer) === teamOf(state.dealer)
    const mayGoAlone = !orderingPartner || state.rules.allowAloneWhenOrderingPartner
    const lonePlayer = action.alone && mayGoAlone ? state.activePlayer : null
    const hands: GameState['hands'] = state.hands.map((hand) => [...hand]) as GameState['hands']
    hands[state.dealer].push(state.upCard)
    const ordered = { ...state, hands, trump, maker: state.activePlayer, lonePlayer }
    return { ...ordered, phase: 'discarding', activePlayer: state.dealer, notice: 'Dealer must discard.' }
  }

  if (action.type === 'call-trump' && state.phase === 'calling' && action.suit !== state.upCard.suit && (!state.rules.requireNaturalTrump || hasNaturalTrump(state.hands[state.activePlayer], action.suit))) {
    return beginPlay({ ...state, trump: action.suit, maker: state.activePlayer, lonePlayer: action.alone ? state.activePlayer : null })
  }

  if (action.type === 'discard' && state.phase === 'discarding' && state.trump !== null) {
    const hand = state.hands[state.dealer]
    if (!hand.some((card) => card.id === action.cardId)) return state
    const hands = state.hands.map((cards) => [...cards]) as GameState['hands']
    hands[state.dealer] = hand.filter((card) => card.id !== action.cardId)
    return beginPlay({ ...state, hands })
  }

  if (action.type === 'play' && state.phase === 'playing' && state.trump !== null) {
    const hand = state.hands[state.activePlayer]
    const card = hand.find((candidate) => candidate.id === action.cardId)
    if (!card || !legalCards(hand, state.trick, state.trump).some((legal) => legal.id === card.id)) return state
    const hands = state.hands.map((cards) => [...cards]) as GameState['hands']
    hands[state.activePlayer] = hand.filter((candidate) => candidate.id !== card.id)
    const trick = [...state.trick, { card, player: state.activePlayer }]
    const cardsNeeded = state.lonePlayer === null ? 4 : 3
    if (trick.length < cardsNeeded) return { ...state, hands, trick, activePlayer: nextActive(state.activePlayer, state.lonePlayer) }

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

export function sortHand(hand: readonly Card[], trump: Suit | null): Card[] {
  return [...hand].sort((a, b) => {
    if (!trump) return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || rankValue[a.rank] - rankValue[b.rank]
    const suitOrder = [...SUITS.filter((suit) => suit !== trump), trump]
    const suitA = effectiveSuit(a, trump)
    const suitB = effectiveSuit(b, trump)
    return suitOrder.indexOf(suitA) - suitOrder.indexOf(suitB) || strength(a, suitA, trump) - strength(b, suitB, trump)
  })
}

function evaluateTrump(hand: readonly Card[], trump: Suit): { count: number; value: number } {
  let count = 0
  let value = 0
  for (const card of hand) {
    if (effectiveSuit(card, trump) !== trump) {
      if (card.rank === 'A') value += 0.5
      continue
    }

    count += 1
    if (card.rank === 'J' && card.suit === trump) value += 4.5
    else if (card.rank === 'J') value += 4
    else value += { A: 2.25, K: 1.5, Q: 1, '10': 0.5, '9': 0.25 }[card.rank]
  }
  return { count, value }
}

function wantsTrump(count: number, value: number, threshold = 5.75): boolean {
  return count >= 3 && value >= threshold
}

function cardCost(card: Card, trump: Suit): number {
  return strength(card, effectiveSuit(card, trump), trump)
}

function weakest(cards: readonly Card[], trump: Suit): Card {
  return [...cards].sort((a, b) => cardCost(a, trump) - cardCost(b, trump))[0]
}

function chooseCard(state: GameState): Card {
  if (state.trump === null) throw new Error('Cannot choose a card without trump.')
  const player = state.activePlayer
  const cards = legalCards(state.hands[player], state.trick, state.trump)

  if (state.trick.length === 0) {
    const trumpCards = cards.filter((card) => effectiveSuit(card, state.trump!) === state.trump)
    const makerIsLeading = state.maker !== null && teamOf(state.maker) === teamOf(player)
    if (makerIsLeading && trumpCards.length >= 2) {
      return [...trumpCards].sort((a, b) => cardCost(b, state.trump!) - cardCost(a, state.trump!))[0]
    }
    const sideAce = cards.find((card) => card.rank === 'A' && effectiveSuit(card, state.trump!) !== state.trump)
    return sideAce ?? weakest(cards, state.trump)
  }

  const currentWinner = trickWinner(state.trick, state.trump)
  if (teamOf(currentWinner) === teamOf(player)) return weakest(cards, state.trump)

  const winningCards = cards.filter((card) => trickWinner([...state.trick, { card, player }], state.trump!) === player)
  return winningCards.length > 0 ? weakest(winningCards, state.trump) : weakest(cards, state.trump)
}

export function chooseBotAction(state: GameState): GameAction | null {
  if (state.phase === 'discarding' && state.trump !== null) {
    return { type: 'discard', cardId: weakest(state.hands[state.dealer], state.trump).id }
  }
  if (state.phase === 'ordering') {
    if (state.rules.requireNaturalTrump && !hasNaturalTrump(state.hands[state.activePlayer], state.upCard.suit)) return { type: 'pass' }
    const hand = state.activePlayer === state.dealer
      ? [...state.hands[state.activePlayer], state.upCard]
      : state.hands[state.activePlayer]
    const { count, value } = evaluateTrump(hand, state.upCard.suit)
    const opponentDealer = teamOf(state.activePlayer) !== teamOf(state.dealer)
    const orderingPartner = state.activePlayer !== state.dealer && !opponentDealer
    const mayGoAlone = !orderingPartner || state.rules.allowAloneWhenOrderingPartner
    return wantsTrump(count, value, opponentDealer ? 6.5 : 5.5)
      ? { type: 'order-up', alone: mayGoAlone && count >= 4 && value >= 9 }
      : { type: 'pass' }
  }
  if (state.phase === 'calling') {
    const available = SUITS.filter((suit) => suit !== state.upCard.suit && (!state.rules.requireNaturalTrump || hasNaturalTrump(state.hands[state.activePlayer], suit)))
    if (available.length === 0) return { type: 'pass' }
    const best = available
      .map((suit) => ({ suit, ...evaluateTrump(state.hands[state.activePlayer], suit) }))
      .sort((a, b) => b.value - a.value)[0]
    return wantsTrump(best.count, best.value) || state.activePlayer === state.dealer
      ? { type: 'call-trump', suit: best.suit, alone: best.count >= 4 && best.value >= 9 }
      : { type: 'pass' }
  }
  if (state.phase === 'playing' && state.trump !== null) {
    return { type: 'play', cardId: chooseCard(state).id }
  }
  return null
}
