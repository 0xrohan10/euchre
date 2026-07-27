import { useEffect, useReducer, useState, type CSSProperties } from 'react'
import { Check, Copy, Settings, Users, Volume2, VolumeX, X } from 'lucide-react'
import './App.css'
import {
  DEFAULT_RULES,
  SUITS,
  chooseBotAction,
  createGame,
  hasNaturalTrump,
  legalCards,
  reduceGame,
  sortHand,
  teamOf,
  type Card as CardType,
  type GameRules,
  type Player,
  type Suit,
} from './game'

const PLAYERS = ['You', 'Mara', 'Jonah', 'Theo']
const SUIT_SYMBOL: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }

function savedRules(): GameRules {
  if (typeof localStorage === 'undefined') return DEFAULT_RULES

  try {
    const saved = localStorage.getItem('kitty-rules')
    return saved ? { ...DEFAULT_RULES, ...JSON.parse(saved) as Partial<GameRules> } : DEFAULT_RULES
  } catch {
    return DEFAULT_RULES
  }
}

function RuleToggle({ name, title, description, checked, onChange }: {
  name: keyof GameRules
  title: string
  description: string
  checked: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <label className="rule-toggle">
      <span><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" name={name} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  )
}

function PlayingCard({ card, playable = false, invalid = false, selected = false, dealIndex, onClick }: {
  card: CardType
  playable?: boolean
  invalid?: boolean
  selected?: boolean
  dealIndex?: number
  onClick?: () => void
}) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds'
  const className = `playing-card ${red ? 'red' : ''} ${playable ? 'playable' : ''} ${invalid ? 'invalid' : ''} ${selected ? 'selected' : ''} ${dealIndex !== undefined ? 'dealt' : ''}`
  const style = dealIndex !== undefined ? { '--deal-index': dealIndex } as CSSProperties : undefined
  const content = (
    <>
      <span className="card-corner"><strong>{card.rank}</strong><span>{SUIT_SYMBOL[card.suit]}</span></span>
      <span className="card-suit" aria-hidden="true">{SUIT_SYMBOL[card.suit]}</span>
    </>
  )

  if (onClick) {
    return <button type="button" className={className} style={style} onClick={onClick} aria-label={`${card.rank} of ${card.suit}`}>{content}</button>
  }
  return <div className={className} style={style} aria-label={`${card.rank} of ${card.suit}`} aria-disabled={invalid || undefined}>{content}</div>
}

function PlayerBadge({ player, active, dealer, partner, tricksWon, maker = false, trump = null, compact = false }: {
  player: Player
  active: boolean
  dealer: boolean
  partner: boolean
  tricksWon: number
  maker?: boolean
  trump?: Suit | null
  compact?: boolean
}) {
  const redTrump = trump === 'hearts' || trump === 'diamonds'

  return (
    <div className={`player-badge ${active ? 'active' : ''} ${compact ? 'compact' : ''}`}>
      {tricksWon > 0 ? (
        <span className="won-tricks" aria-label={`${tricksWon} ${tricksWon === 1 ? 'trick' : 'tricks'} won`}>
          {Array.from({ length: tricksWon }, (_, index) => <i className="won-trick-card" key={index} />)}
        </span>
      ) : null}
      {maker && trump ? <span className={`maker-chip ${redTrump ? 'red' : ''}`} title={`Called ${trump}`} aria-label={`Called ${trump}`}>{SUIT_SYMBOL[trump]}</span> : null}
      <div className={`avatar avatar-${player}`}>{PLAYERS[player][0]}</div>
      <div className="player-copy">
        <strong>{PLAYERS[player]}</strong>
        <span>{partner ? 'Your partner' : player === 0 ? 'South' : ['','West','North','East'][player]}</span>
      </div>
      {dealer ? <span className="dealer-chip" title="Dealer" aria-label="Dealer">D</span> : null}
      {active ? <span className="turn-dot" aria-label="Current turn" /> : null}
    </div>
  )
}

function HiddenHand({ count }: { count: number }) {
  return (
    <div className="hidden-hand" aria-label={`${count} cards remaining`}>
      {Array.from({ length: count }, (_, index) => <div className="card-back" style={{ '--deal-index': index } as CSSProperties} key={index} />)}
    </div>
  )
}

export default function App() {
  const [game, dispatch] = useReducer(reduceGame, undefined, () => createGame(undefined, savedRules()))
  const [dealingHand, setDealingHand] = useState<number | null>(game.handNumber)
  const [goingAlone, setGoingAlone] = useState(false)
  const [copied, setCopied] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [muted, setMuted] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('kitty-muted') === 'true')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const humanTurn = game.activePlayer === 0
  const showingCompletedTrick = game.phase === 'trick-complete'
  const choosingTrump = humanTurn && (game.phase === 'ordering' || game.phase === 'calling')
  const humanCards = sortHand(game.hands[0], game.trump)
  const canOrderUp = !game.rules.requireNaturalTrump || hasNaturalTrump(game.hands[0], game.upCard.suit)
  const callableSuits = SUITS.filter((suit) => suit !== game.upCard.suit && (!game.rules.requireNaturalTrump || hasNaturalTrump(game.hands[0], suit)))
  const orderingPartner = game.phase === 'ordering' && game.activePlayer !== game.dealer && teamOf(game.activePlayer) === teamOf(game.dealer)
  const partnerLonerBlocked = orderingPartner && !game.rules.allowAloneWhenOrderingPartner
  const legal = game.phase === 'playing' && humanTurn && game.trump
    ? new Set(legalCards(game.hands[0], game.trick, game.trump).map((card) => card.id))
    : new Set<string>()

  useEffect(() => {
    if (game.phase === 'trick-complete') {
      const timer = window.setTimeout(() => dispatch({ type: 'collect-trick' }), 1600)
      return () => window.clearTimeout(timer)
    }
    if (humanTurn || game.phase === 'hand-over' || game.phase === 'match-over' || game.phase === 'discarding') return
    const action = chooseBotAction(game)
    if (!action) return
    const timer = window.setTimeout(() => dispatch(action), game.phase === 'playing' ? 650 : 900)
    return () => window.clearTimeout(timer)
  }, [game, humanTurn])

  useEffect(() => {
    setDealingHand(game.handNumber)
    const timer = window.setTimeout(() => setDealingHand(null), 520)
    return () => window.clearTimeout(timer)
  }, [game.handNumber])

  useEffect(() => {
    localStorage.setItem('kitty-rules', JSON.stringify(game.rules))
  }, [game.rules])

  useEffect(() => {
    if (!settingsOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [settingsOpen])

  const copyRoomCode = async () => {
    await navigator.clipboard?.writeText('W6K9')
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const toggleSound = () => {
    setMuted((current) => {
      localStorage.setItem('kitty-muted', String(!current))
      return !current
    })
  }

  const inviteToTable = async () => {
    const inviteUrl = new URL(window.location.href)
    inviteUrl.searchParams.set('room', 'W6K9')
    await navigator.clipboard?.writeText(inviteUrl.toString())
    setInviteCopied(true)
    window.setTimeout(() => setInviteCopied(false), 1600)
  }

  const act = (action: Parameters<typeof dispatch>[0]) => {
    dispatch(action)
    setGoingAlone(false)
  }

  const turnLabel = game.phase === 'hand-over' || game.phase === 'match-over'
    ? game.notice
    : humanTurn ? game.notice : `${PLAYERS[game.activePlayer]} is thinking…`

  return (
    <main className="game-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Kitty home">
          <span className="brand-mark">K</span>
          <span>Kitty</span>
        </a>
        <div className="room-meta">
          <span className="eyebrow">Private table</span>
          <button type="button" className="room-code" onClick={copyRoomCode} aria-label="Copy room code W6K9">
            W6K9 {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="header-actions">
          <button type="button" className={`icon-button ${muted ? 'active' : ''}`} onClick={toggleSound} aria-label={muted ? 'Unmute sound' : 'Mute sound'} aria-pressed={muted}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          <button type="button" className={`icon-button ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen(true)} aria-label="Table settings" aria-expanded={settingsOpen}><Settings size={18} /></button>
          <button type="button" className="invite-button" onClick={inviteToTable}>{inviteCopied ? <Check size={16} /> : <Users size={16} />} {inviteCopied ? 'Copied' : 'Invite'}</button>
        </div>
      </header>

      <section className="match-layout">
        <aside className="score-panel" aria-label="Match score">
          <div className="score-heading">
            <div><span className="eyebrow">First to 10</span><h1>Friendly match</h1></div>
            <span className="hand-count">Hand {game.handNumber}</span>
          </div>
          <div className="score-row us">
            <div><span className="team-pips"><i /><i /></span><strong>You & Jonah</strong></div>
            <span className="score">{game.score[0]}</span>
          </div>
          <div className="score-row">
            <div><span className="team-pips opponents"><i /><i /></span><strong>Mara & Theo</strong></div>
            <span className="score">{game.score[1]}</span>
          </div>
          <div className="hand-status">
            <span>Tricks</span>
            <strong>{game.tricks[0]}–{game.tricks[1]}</strong>
          </div>
          <p className="rules-note">{[
            game.rules.stickDealer ? 'Stick the dealer' : 'Dealer may pass',
            game.rules.requireNaturalTrump ? 'Natural trump required' : null,
            game.rules.allowAloneWhenOrderingPartner ? 'Partner-order loners' : null,
          ].filter(Boolean).join(' · ')}</p>
        </aside>

        <section className="table-wrap" aria-label="Euchre table">
          <div className="felt-table">
            <div className="seat seat-north">
              <PlayerBadge player={2} active={game.activePlayer === 2} dealer={game.dealer === 2} partner tricksWon={game.playerTricks[2]} maker={game.maker === 2} trump={game.trump} />
              {game.lonePlayer !== 0 ? <HiddenHand count={game.hands[2].length} /> : <span className="sitting-out">Sitting out</span>}
            </div>
            <div className="seat seat-west">
              <PlayerBadge compact player={1} active={game.activePlayer === 1} dealer={game.dealer === 1} partner={false} tricksWon={game.playerTricks[1]} maker={game.maker === 1} trump={game.trump} />
              {game.lonePlayer !== 3 ? <HiddenHand count={game.hands[1].length} /> : <span className="sitting-out">Sitting out</span>}
            </div>
            <div className="seat seat-east">
              <PlayerBadge compact player={3} active={game.activePlayer === 3} dealer={game.dealer === 3} partner={false} tricksWon={game.playerTricks[3]} maker={game.maker === 3} trump={game.trump} />
              {game.lonePlayer !== 1 ? <HiddenHand count={game.hands[3].length} /> : <span className="sitting-out">Sitting out</span>}
            </div>

            <div className="table-center">
              {game.trump ? <div className={`trump-chip ${game.trump === 'hearts' || game.trump === 'diamonds' ? 'red' : ''}`}><span>{SUIT_SYMBOL[game.trump]}</span> Trump</div> : null}
              <div className={`trick-area ${showingCompletedTrick ? 'complete' : ''}`}>
                {game.trick.map((played) => (
                  <div className={`trick-card trick-player-${played.player} ${showingCompletedTrick && played.player === game.lastTrickWinner ? 'winner' : ''}`} key={played.card.id}>
                    <PlayingCard card={played.card} />
                  </div>
                ))}
                {showingCompletedTrick && game.lastTrickWinner !== null ? (
                  <div className="trick-result" role="status">
                    <span className="trick-result-check">✓</span>
                    <strong>{game.lastTrickWinner === 0 ? 'You take the trick' : `${PLAYERS[game.lastTrickWinner]} takes the trick`}</strong>
                  </div>
                ) : null}
                {game.phase === 'hand-over' ? (
                  <div className="hand-result" role="status">
                    <span className="eyebrow">Hand complete</span>
                    <strong>{game.notice}</strong>
                    <button type="button" onClick={() => act({ type: 'next-hand' })}>Start next hand</button>
                  </div>
                ) : null}
                {game.trick.length === 0 && game.phase === 'playing'
                  ? <span className="lead-hint">{game.activePlayer === 0 ? 'Lead a card' : 'Waiting for lead'}</span>
                  : null}
              </div>
              {(game.phase === 'ordering' || game.phase === 'calling') ? (
                <div className="up-card">
                  <PlayingCard key={game.upCard.id} card={game.upCard} dealIndex={dealingHand === game.handNumber ? 0 : undefined} />
                  <span>{game.phase === 'ordering' ? 'Turned up' : 'Turned down'}</span>
                </div>
              ) : null}
            </div>

            <div className="seat seat-south">
              <PlayerBadge player={0} active={humanTurn} dealer={game.dealer === 0} partner={false} tricksWon={game.playerTricks[0]} maker={game.maker === 0} trump={game.trump} />
              {game.lonePlayer !== 2 ? (
                <div className="human-hand">
                  {humanCards.map((card, index) => {
                    const playable = game.phase === 'discarding' || legal.has(card.id)
                    const invalid = game.phase === 'playing' && humanTurn && !legal.has(card.id)
                    return <PlayingCard key={card.id} card={card} playable={playable} invalid={invalid} dealIndex={dealingHand === game.handNumber ? index : undefined} onClick={playable ? () => act(game.phase === 'discarding' ? { type: 'discard', cardId: card.id } : { type: 'play', cardId: card.id }) : undefined} />
                  })}
                </div>
              ) : <span className="sitting-out">Your partner is going alone</span>}
            </div>
          </div>

          <div className={`action-bar ${choosingTrump ? 'has-controls' : ''}`} aria-live="polite">
            <div className="turn-copy">
              <span className={`status-light ${humanTurn && !showingCompletedTrick ? 'your-turn' : ''}`} />
              <div><span className="eyebrow">{showingCompletedTrick ? 'Trick complete' : humanTurn ? 'Your turn' : 'At the table'}</span><strong>{turnLabel}</strong></div>
            </div>
            {choosingTrump ? (
              <div className="bid-controls">
                {!(game.phase === 'calling' && game.activePlayer === game.dealer && callableSuits.length > 0) ? <button type="button" className="quiet-button" onClick={() => act({ type: 'pass' })}>{game.phase === 'calling' && game.activePlayer === game.dealer ? 'Redeal' : 'Pass'}</button> : null}
                {game.phase === 'ordering' ? (
                  <button type="button" className="primary-button" disabled={!canOrderUp} title={!canOrderUp ? `A natural ${game.upCard.suit} is required` : undefined} onClick={() => act({ type: 'order-up', alone: goingAlone })}>Order up {SUIT_SYMBOL[game.upCard.suit]}</button>
                ) : (
                  <div className="suit-buttons">
                    {callableSuits.map((suit) => <button type="button" key={suit} className={suit === 'hearts' || suit === 'diamonds' ? 'red' : ''} onClick={() => act({ type: 'call-trump', suit, alone: goingAlone })} aria-label={`Call ${suit}`}>{SUIT_SYMBOL[suit]}</button>)}
                  </div>
                )}
                <label className="alone-toggle" title={partnerLonerBlocked ? 'Enable partner-order loners in table settings' : undefined}><input type="checkbox" name="going-alone" checked={goingAlone} disabled={game.phase === 'ordering' ? !canOrderUp || partnerLonerBlocked : callableSuits.length === 0} onChange={(event) => setGoingAlone(event.target.checked)} /> Go alone</label>
              </div>
            ) : null}
            {game.phase === 'match-over' ? <button type="button" className="primary-button" onClick={() => act({ type: 'new-match' })}>Play again</button> : null}
          </div>
        </section>
      </section>
      {settingsOpen ? (
        <div className="settings-scrim" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false)
        }}>
          <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <header className="settings-header">
              <div><span className="eyebrow">Private table</span><h2 id="settings-title">Table settings</h2></div>
              <button type="button" className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings" autoFocus><X size={18} /></button>
            </header>
            <div className="settings-section">
              <span className="settings-label">House rules</span>
              <RuleToggle name="stickDealer" title="Stick the dealer" description="The dealer must choose trump in the second round." checked={game.rules.stickDealer} onChange={(enabled) => dispatch({ type: 'set-rule', rule: 'stickDealer', enabled })} />
              <RuleToggle name="requireNaturalTrump" title="Require natural trump" description="A caller must hold the printed suit. The left bower does not count." checked={game.rules.requireNaturalTrump} onChange={(enabled) => dispatch({ type: 'set-rule', rule: 'requireNaturalTrump', enabled })} />
              <RuleToggle name="allowAloneWhenOrderingPartner" title="Partner-order loners" description="Allow a player to go alone when ordering up their dealer-partner." checked={game.rules.allowAloneWhenOrderingPartner} onChange={(enabled) => dispatch({ type: 'set-rule', rule: 'allowAloneWhenOrderingPartner', enabled })} />
            </div>
            <p className="settings-note">Changes apply immediately and are saved for future matches.</p>
          </section>
        </div>
      ) : null}
    </main>
  )
}
