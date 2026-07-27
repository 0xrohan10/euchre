import { useEffect, useState, type FormEvent } from 'react'
import { authClient } from './lib/auth-client'
import { createRoomFn, getCurrentRoomFn, getRoomFn, joinRoomFn, submitCommandFn, voteForBotFn } from './server/game.functions'
import { hasNaturalTrump, legalCards, sortHand, SUITS, teamOf, type Card, type GameAction, type Player, type Suit } from './game'
import { acceptRoomUpdate, canPassCalling, playerAt, relativePlayer, type RoomView, type SeatView } from './multiplayer'
import './App.css'

const SUIT_SYMBOL: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }

function CardFace({ card, playable = false, onClick }: { card: Card; playable?: boolean; onClick?: () => void }) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds'
  const className = `playing-card dealt ${red ? 'red' : ''} ${onClick ? (playable ? 'playable' : 'invalid') : ''}`
  const content = <><span className="card-corner"><strong>{card.rank}</strong><span>{SUIT_SYMBOL[card.suit]}</span></span><span className="card-suit">{SUIT_SYMBOL[card.suit]}</span></>
  return onClick ? <button className={className} disabled={!playable} onClick={onClick}>{content}</button> : <div className={className}>{content}</div>
}

function Brand() {
  return <a className="brand" href="/" aria-label="Homepage">
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect className="brand-mark-back" x="4" y="4.5" width="11" height="15" rx="2.6" transform="rotate(-20 9.5 12)" />
      <rect className="brand-mark-front" x="11.2" y="3.5" width="11" height="16" rx="2.8" />
      <path className="brand-mark-pip" d="M16.7 8.7 19.5 11.5 16.7 14.3 13.9 11.5Z" />
    </svg>
    <span>Euchs</span>
  </a>
}

function HiddenHand({ count }: { count: number }) {
  return <div className="hidden-hand">{Array.from({ length: count }, (_, index) => <i className="card-back" key={index} />)}</div>
}

function PlayerBadge({ occupant, active, dealer }: { occupant?: SeatView; active: boolean; dealer: boolean }) {
  if (!occupant) return <div className="player-badge"><span className="avatar">?</span><span className="player-copy"><strong>Open seat</strong><span>Waiting</span></span></div>
  return <div className={`player-badge ${active ? 'active' : ''}`}>
    <span className={`avatar avatar-${occupant.seat}`}>{occupant.name.slice(0, 2).toUpperCase()}</span>
    <span className="player-copy"><strong>{occupant.name}</strong><span>{occupant.controller === 'bot' ? 'Bot playing' : occupant.connected ? 'Connected' : 'Disconnected'}</span></span>
    {dealer && <span className="dealer-chip">D</span>}
    {active && <i className="turn-dot" />}
  </div>
}

function AuthScreen() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError('')
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email'))
    const password = String(data.get('password'))
    const result = mode === 'sign-up'
      ? await authClient.signUp.email({ email, password, name: String(data.get('name')) })
      : await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) setError(result.error.message ?? 'Authentication failed.')
    else window.location.reload()
  }

  return <main className="auth-shell">
    <section className="auth-card">
      <Brand />
      <div><span className="eyebrow">Private tables</span><h1>{mode === 'sign-in' ? 'Take your seat.' : 'Join the table.'}</h1><p>Server-authoritative Euchre for four players.</p></div>
      <form onSubmit={submit}>
        {mode === 'sign-up' && <label>Name<input name="name" required minLength={2} autoComplete="name" /></label>}
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        <label>Password<input name="password" type="password" required minLength={8} autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={pending}>{pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
      </form>
      <button className="quiet-button" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>{mode === 'sign-in' ? 'Create an account' : 'Already have an account'}</button>
    </section>
  </main>
}

function Lobby({ room, onRoom, userName }: { room: RoomView | null; onRoom: (room: RoomView) => void; userName: string }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function run(operation: () => Promise<RoomView>) {
    setPending(true)
    setError('')
    try { onRoom(await operation()) } catch { setError('Could not open that table.') } finally { setPending(false) }
  }
  return <main className="lobby-shell">
    <header className="app-header"><Brand /><div className="header-actions"><span className="eyebrow">{userName}</span><button className="quiet-button" onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button></div></header>
    <section className="lobby-card">
      {room ? <>
        <span className="eyebrow">Invite table</span><h1>Waiting for four</h1><button className="room-code large" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}?room=${room.code}`)}>{room.code} · Copy invite</button>
        <div className="lobby-seats">{[0, 1, 2, 3].map((seat) => <PlayerBadge key={seat} occupant={room.seats.find((item) => item.seat === seat)} active={false} dealer={false} />)}</div>
        <p>The match starts automatically when the fourth player joins.</p>
      </> : <>
        <span className="eyebrow">Multiplayer Euchre</span><h1>Pull up a chair.</h1><p>Create a private table or enter a six-character invite code.</p>
        <button className="primary-button" disabled={pending} onClick={() => void run(() => createRoomFn())}>Create a table</button>
        <form className="join-form" onSubmit={(event) => { event.preventDefault(); void run(() => joinRoomFn({ data: { code } })) }}><input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="INVITE" maxLength={6} required /><button className="quiet-button" disabled={pending}>Join</button></form>
      </>}
      {error && <p className="form-error">{error}</p>}
    </section>
  </main>
}

function GameTable({ room, onRoom }: { room: RoomView; onRoom: (room: RoomView) => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [alone, setAlone] = useState(false)
  const game = room.game!
  const viewer = room.viewerSeat
  const viewerTeam = teamOf(viewer)
  const opponentTeam = (1 - viewerTeam) as 0 | 1
  const isTurn = room.status === 'playing' && game.activePlayer === viewer
  const hand = sortHand(game.hand, game.trump)
  const legal = game.phase === 'playing' && game.trump ? new Set(legalCards(game.hand, game.trick, game.trump).map((card) => card.id)) : new Set<string>()

  async function act(action: GameAction) {
    setPending(true)
    setError('')
    try {
      const next = await submitCommandFn({ data: { roomId: room.id, commandId: crypto.randomUUID(), expectedVersion: room.version, action } })
      onRoom(next)
      setAlone(false)
    } catch {
      setError('The table changed before that action. Your view was refreshed.')
      try { onRoom(await getRoomFn({ data: { roomId: room.id } })) } catch { /* The SSE connection remains the fallback. */ }
    } finally { setPending(false) }
  }

  const controls = isTurn && !pending && (game.phase === 'ordering' || game.phase === 'calling')
  const availableSuits = SUITS.filter((suit) => game.phase === 'calling' && suit !== game.upCard.suit && (!game.rules.requireNaturalTrump || hasNaturalTrump(game.hand, suit)))
  return <div className="game-shell">
    <header className="app-header"><Brand /><div className="room-meta"><span className="eyebrow">Table</span><button className="room-code" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}?room=${room.code}`)}>{room.code}</button></div><div className="header-actions"><button className="quiet-button" onClick={() => void authClient.signOut().then(() => window.location.reload())}>Sign out</button></div></header>
    <div className="match-layout">
      <aside className="score-panel"><div className="score-heading"><div><span className="eyebrow">Match to 10</span><h1>Score</h1></div><span className="hand-count">Hand {game.handNumber}</span></div><div className="score-row us"><strong>Your team</strong><span className="score">{game.score[viewerTeam]}</span></div><div className="score-row"><strong>Opponents</strong><span className="score">{game.score[opponentTeam]}</span></div><div className="hand-status"><span>Tricks</span><strong>{game.tricks[viewerTeam]}–{game.tricks[opponentTeam]}</strong></div></aside>
      <main className="table-wrap"><section className="felt-table">
        {([0, 1, 2, 3] as Player[]).map((relative) => {
          const player = playerAt(viewer, relative)
          const occupant = room.seats.find((seat) => seat.seat === player)
          const position = ['south', 'west', 'north', 'east'][relative]
          return <div className={`seat seat-${position}`} key={player}><PlayerBadge occupant={occupant} active={game.activePlayer === player} dealer={game.dealer === player} />{relative === 0 ? <div className="human-hand">{hand.map((card) => <CardFace key={card.id} card={card} playable={isTurn && (game.phase === 'discarding' || legal.has(card.id))} onClick={() => void act({ type: game.phase === 'discarding' ? 'discard' : 'play', cardId: card.id })} />)}</div> : <HiddenHand count={game.handCounts[player]} />}</div>
        })}
        <div className="table-center">{game.trump && <div className={`trump-chip ${game.trump === 'hearts' || game.trump === 'diamonds' ? 'red' : ''}`}><span>{SUIT_SYMBOL[game.trump]}</span> trump</div>}<div className="trick-area">{game.trick.map((played) => <div key={played.card.id} className={`trick-card trick-player-${relativePlayer(played.player, viewer)}`}><CardFace card={played.card} /></div>)}{game.trick.length === 0 && game.phase === 'ordering' && <div className="up-card"><CardFace card={game.upCard} /></div>}</div></div>
      </section>
      <section className={`action-bar ${controls ? 'has-controls' : ''}`}><div className="turn-copy"><i className={`status-light ${isTurn ? 'your-turn' : ''}`} /><div><span className="eyebrow">{room.status === 'paused' ? 'Game paused' : isTurn ? 'Your turn' : 'At the table'}</span><strong>{error || game.notice}</strong></div></div>{controls && <div className="bid-controls">{game.phase === 'ordering' ? <><button className="primary-button" disabled={game.rules.requireNaturalTrump && !hasNaturalTrump(game.hand, game.upCard.suit)} onClick={() => void act({ type: 'order-up', alone })}>Order up</button><button className="quiet-button" onClick={() => void act({ type: 'pass' })}>Pass</button></> : <><div className="suit-buttons">{availableSuits.map((suit) => <button className={suit === 'hearts' || suit === 'diamonds' ? 'red' : ''} key={suit} onClick={() => void act({ type: 'call-trump', suit, alone })}>{SUIT_SYMBOL[suit]}</button>)}</div>{canPassCalling(game.rules.stickDealer, game.activePlayer === game.dealer, availableSuits.length) && <button className="quiet-button" onClick={() => void act({ type: 'pass' })}>Pass</button>}</>}<label className="alone-toggle"><input type="checkbox" checked={alone} onChange={(event) => setAlone(event.target.checked)} />Go alone</label></div>}
      </section>
      </main>
    </div>
    {!room.disconnectVote && (game.phase === 'hand-over' || game.phase === 'match-over') && <div className="settings-scrim"><section className="settings-panel"><div className="settings-header"><div><span className="eyebrow">{game.phase === 'match-over' ? 'Match complete' : 'Hand complete'}</span><h2>{game.notice}</h2></div></div><div className="settings-section">{room.hostUserId === room.seats.find((seat) => seat.seat === viewer)?.userId ? <button className="primary-button" onClick={() => void act({ type: game.phase === 'hand-over' ? 'next-hand' : 'new-match' })}>{game.phase === 'hand-over' ? 'Next hand' : 'Play again'}</button> : <p>Waiting for the host to continue.</p>}</div></section></div>}
    {room.disconnectVote && <div className="settings-scrim"><section className="settings-panel"><div className="settings-header"><div><span className="eyebrow">Unanimous decision</span><h2>{room.seats.find((seat) => seat.seat === room.disconnectVote?.disconnectedSeat)?.name} disconnected</h2></div></div><div className="settings-section"><p>Every connected human player must approve bot takeover. The player can reclaim their seat whenever they return.</p><button className="primary-button" onClick={() => void voteForBotFn({ data: { roomId: room.id, disconnectedSeat: room.disconnectVote!.disconnectedSeat, approve: true } }).then(onRoom)}>Approve bot takeover</button><button className="quiet-button" onClick={() => void voteForBotFn({ data: { roomId: room.id, disconnectedSeat: room.disconnectVote!.disconnectedSeat, approve: false } }).then(onRoom)}>Keep waiting</button><p>{room.disconnectVote.approvals.length} of {room.disconnectVote.requiredApprovals} approvals</p></div></section></div>}
  </div>
}

export default function App() {
  const { data: session, isPending } = authClient.useSession()
  const [room, setRoom] = useState<RoomView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const roomId = room?.id
  const updateRoom = (next: RoomView) => setRoom((current) => acceptRoomUpdate(current, next))

  useEffect(() => {
    if (!session || loaded) return
    const invite = new URLSearchParams(window.location.search).get('room')
    const load = invite ? joinRoomFn({ data: { code: invite } }) : getCurrentRoomFn()
    void load.then((next) => next && setRoom((current) => acceptRoomUpdate(current, next))).finally(() => setLoaded(true))
  }, [loaded, session])

  useEffect(() => {
    if (!roomId) return
    const events = new EventSource(`/api/tables/${roomId}/events`)
    events.addEventListener('room', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RoomView
      setRoom((current) => acceptRoomUpdate(current, next))
    })
    return () => events.close()
  }, [roomId])

  if (isPending) return <main className="auth-shell"><span className="eyebrow">Loading table…</span></main>
  if (!session) return <AuthScreen />
  if (!loaded) return <main className="auth-shell"><span className="eyebrow">Finding your seat…</span></main>
  if (!room || room.status === 'lobby' || !room.game) return <Lobby room={room} onRoom={updateRoom} userName={session.user.name} />
  return <GameTable room={room} onRoom={updateRoom} />
}
