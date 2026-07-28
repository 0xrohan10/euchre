import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react'
import { useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { authClient } from './lib/auth-client'
import { cardBackImage, cardImage, scoreFiveImages } from './card-assets'
import {
  confirmRematchFn,
  createPartyFn,
  createRoomFn,
  createSinglePlayerRoomFn,
  getCurrentPartyFn,
  getCurrentRoomFn,
  getRoomFn,
  joinPartyFn,
  joinRoomFn,
  leavePartyFn,
  leaveRoomFn,
  startPartyRoomFn,
  submitCommandFn,
  voteForBotFn,
} from './server/game.functions'
import {
  DEFAULT_RULES,
  hasNaturalTrump,
  legalCards,
  sortHand,
  SUITS,
  teamOf,
  type Card,
  type GameAction,
  type GameRules,
  type Player,
  type Suit,
} from './game'
import {
  acceptRoomUpdate,
  canPassCalling,
  optimisticRoomAction,
  playerAt,
  relativePlayer,
  type PartyView,
  type RoomView,
  type SeatView,
} from './multiplayer'
import './App.css'

const SUIT_SYMBOL: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' }

function CardFace({
  card,
  playable = false,
  dimmed = false,
  motionClass = '',
  onClick,
}: {
  card: Card
  playable?: boolean
  dimmed?: boolean
  motionClass?: string
  onClick?: () => void
}) {
  const className = `playing-card dealt ${playable ? 'playable' : dimmed ? 'invalid' : ''} ${motionClass}`
  const content = (
    <img className="card-art" src={cardImage(card)} alt={`${card.rank} of ${card.suit}`} />
  )
  return onClick ? (
    <button className={className} disabled={!playable} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

function Brand() {
  return (
    <a className="brand" href="/" aria-label="Homepage">
      <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect
          className="brand-mark-back"
          x="4"
          y="4.5"
          width="11"
          height="15"
          rx="2.6"
          transform="rotate(-20 9.5 12)"
        />
        <rect className="brand-mark-front" x="11.2" y="3.5" width="11" height="16" rx="2.8" />
        <path className="brand-mark-pip" d="M16.7 8.7 19.5 11.5 16.7 14.3 13.9 11.5Z" />
      </svg>
      <span>Euchs</span>
    </a>
  )
}

function HowToPlay({ label = 'Rules' }: { label?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null)

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
                    Four players form two teams, with partners seated across from each other. The
                    deck has 24 cards: 9, 10, jack, queen, king, and ace in each suit. Everyone gets
                    five cards.
                  </p>
                </div>
              </section>
              <section className="rule-step">
                <span>2</span>
                <div>
                  <h3>Choose trump</h3>
                  <p>
                    A card is turned up. Starting left of the dealer, players may order up its suit
                    or pass. If everyone passes, players call any other suit. The dealer must call
                    if the choice returns to them.
                  </p>
                </div>
              </section>
              <section className="rule-step">
                <span>3</span>
                <div>
                  <h3>Know the bowers</h3>
                  <p>
                    The jack of trump is the highest card, called the right bower. The jack of the
                    same color is the second highest, called the left bower, and counts as trump
                    instead of its printed suit.
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
                When calling trump, you may go alone. Your partner sits out the hand, and taking all
                five tricks earns 4 points.
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
      </dialog>
    </>
  )
}

function HiddenHand({ count }: { count: number }) {
  return (
    <div className="hidden-hand" aria-label={`${count} hidden cards`}>
      {Array.from({ length: count }, (_, index) => {
        return <img className="card-back" src={cardBackImage} alt="" key={index} />
      })}
    </div>
  )
}

function FarmerExchange({ cards, player }: { cards: Card[]; player: Player }) {
  return (
    <div className={`farmer-exchange exchange-player-${player}`} aria-hidden="true">
      {([0, 1, 2] as const).map((index) => {
        return (
          <div
            className="exchange-card exchange-card-out"
            key={`out-${index}`}
            style={
              {
                '--exchange-delay': `${index * 32}ms`,
                '--exchange-fan': `${(index - 1) * 28}px`,
                '--exchange-rotation': `${(index - 1) * 5}deg`,
                '--exchange-stack': `${(index - 1) * 4}px`,
                '--exchange-stack-rotation': `${index - 1}deg`,
              } as CSSProperties
            }
          >
            <img src={cards[index] ? cardImage(cards[index]) : cardBackImage} alt="" />
          </div>
        )
      })}
      {([0, 1, 2] as const).map((index) => {
        return (
          <div
            className="exchange-card exchange-card-in"
            key={`in-${index}`}
            style={
              {
                '--exchange-delay': `${32 + index * 32}ms`,
                '--exchange-fan': `${(index - 1) * 28}px`,
                '--exchange-rotation': `${(index - 1) * 5}deg`,
                '--exchange-stack': `${(index - 1) * 4}px`,
                '--exchange-stack-rotation': `${index - 1}deg`,
              } as CSSProperties
            }
          >
            <img src={cardBackImage} alt="" />
          </div>
        )
      })}
    </div>
  )
}

function FiveScore({ score, team, isViewer }: { score: number; team: 0 | 1; isViewer: boolean }) {
  const teamName = team === 0 ? 'Black team' : 'Red team'
  const face = scoreFiveImages[team]
  return (
    <section
      className={`score-team team-${team === 0 ? 'black' : 'red'}`}
      aria-label={`${teamName}: ${score} points`}
    >
      <div className="score-team-heading">
        <span className="team-name">
          <i />
          {teamName}
          {isViewer && <em>You</em>}
        </span>
        <strong>
          {score}
          <small>/10</small>
        </strong>
      </div>
      <div className="score-fives" key={score}>
        <div className={`score-five-stack score-${score}`}>
          <img className="score-five lower" src={score === 0 ? cardBackImage : face} alt="" />
          <img className="score-five cover" src={score < 5 ? cardBackImage : face} alt="" />
        </div>
      </div>
    </section>
  )
}

function PlayerBadge({
  occupant,
  active,
  dealer,
  maker = false,
  lone = false,
  tricks,
}: {
  occupant?: SeatView
  active: boolean
  dealer: boolean
  maker?: boolean
  lone?: boolean
  tricks?: number
}) {
  if (!occupant) {
    return (
      <div className="player-badge">
        <span className="avatar">?</span>
        <span className="player-copy">
          <strong>Open seat</strong>
          <span>Waiting</span>
        </span>
      </div>
    )
  }
  const trickLabel = tricks === 1 ? '1 trick' : `${tricks ?? 0} tricks`
  const status =
    tricks === undefined
      ? occupant.controller === 'bot'
        ? 'Bot playing'
        : occupant.connected
          ? 'Connected'
          : 'Disconnected'
      : active
        ? `${occupant.controller === 'bot' ? 'Thinking' : 'Playing'} · ${trickLabel}`
        : `${trickLabel} won`
  return (
    <div className={`player-badge ${active ? 'active' : ''}`}>
      <span className={`avatar avatar-${occupant.seat}`}>
        {occupant.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="player-copy">
        <span className="player-name">
          <strong>{occupant.name}</strong>
          {maker && <em>{lone ? 'Called alone' : 'Called'}</em>}
        </span>
        <span>{status}</span>
      </span>
      {dealer && <span className="dealer-chip">D</span>}
      {active && <i className="turn-dot" />}
    </div>
  )
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
    const result =
      mode === 'sign-up'
        ? await authClient.signUp.email({ email, password, name: String(data.get('name')) })
        : await authClient.signIn.email({ email, password })
    setPending(false)
    if (result.error) {
      setError(result.error.message ?? 'Authentication failed.')
    } else {
      window.location.reload()
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <Brand />
        <div>
          <span className="eyebrow">Private tables</span>
          <h1>{mode === 'sign-in' ? 'Take your seat.' : 'Join the table.'}</h1>
          <p>Online Euchre for one or four players.</p>
        </div>
        <form onSubmit={submit}>
          {mode === 'sign-up' && (
            <label>
              Name
              <input name="name" required minLength={2} autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={pending}>
            {pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="auth-secondary-actions">
          <button
            className="quiet-button"
            onClick={() => {
              return setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
            }}
          >
            {mode === 'sign-in' ? 'Create an account' : 'Already have an account'}
          </button>
          <HowToPlay label="How to play" />
        </div>
      </section>
    </main>
  )
}

function RuleToggle({
  checked,
  description,
  disabled,
  onChange,
  title,
}: {
  checked: boolean
  description: string
  disabled: boolean
  onChange: (checked: boolean) => void
  title: string
}) {
  return (
    <label className="rule-toggle">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          return onChange(event.target.checked)
        }}
      />
      <i aria-hidden="true" />
    </label>
  )
}

function Lobby({
  room,
  party,
  initialError,
  onRoom,
  onParty,
  onLeave,
  userId,
  userName,
}: {
  room: RoomView | null
  party: PartyView | null
  initialError?: string
  onRoom: (room: RoomView) => void
  onParty: (party: PartyView | null) => void
  onLeave: () => void
  userId: string
  userName: string
}) {
  const [mode, setMode] = useState<'multiplayer' | null>(null)
  const [setupMode, setSetupMode] = useState<'single-player' | 'multiplayer' | 'partner' | null>(
    null,
  )
  const [rules, setRules] = useState<GameRules>({ ...DEFAULT_RULES })
  const [code, setCode] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('kitty-rules') ?? 'null',
      ) as Partial<GameRules> | null
      if (
        saved &&
        typeof saved.stickDealer === 'boolean' &&
        typeof saved.requireNaturalTrump === 'boolean' &&
        typeof saved.allowAloneWhenOrderingPartner === 'boolean'
      ) {
        setRules({ ...DEFAULT_RULES, ...saved })
      }
    } catch {
      /* Keep the standard rules when saved preferences are unreadable. */
    }
  }, [])

  function setRule(rule: keyof GameRules, enabled: boolean) {
    const next = { ...rules, [rule]: enabled }
    setRules(next)
    localStorage.setItem('kitty-rules', JSON.stringify(next))
  }
  async function run(operation: () => Promise<RoomView>) {
    setPending(true)
    setError('')
    try {
      onRoom(await operation())
    } catch {
      setError('Could not open that table.')
    } finally {
      setPending(false)
    }
  }
  async function leave() {
    if (!room) {
      return
    }
    setPending(true)
    setError('')
    try {
      await leaveRoomFn({ data: { roomId: room.id } })
      onLeave()
    } catch {
      setError('Could not leave that table.')
    } finally {
      setPending(false)
    }
  }
  async function createPartnership() {
    setPending(true)
    setError('')
    try {
      onParty(await createPartyFn())
    } catch {
      setError('Could not create a partnership.')
    } finally {
      setPending(false)
    }
  }
  async function leavePartnership() {
    setPending(true)
    setError('')
    try {
      await leavePartyFn()
      onParty(null)
      setSetupMode(null)
    } catch {
      setError('Could not leave this partnership.')
    } finally {
      setPending(false)
    }
  }
  return (
    <main className="lobby-shell">
      <header className="app-header">
        <Brand />
        <div className="header-actions">
          <span className="eyebrow">{userName}</span>
          <HowToPlay />
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
      <section className="lobby-card">
        {room ? (
          <>
            <span className="eyebrow">Invite table</span>
            <h1>Waiting for four</h1>
            <button
              className="room-code large"
              onClick={() => {
                return void navigator.clipboard.writeText(
                  `${window.location.origin}/games/${room.code}`,
                )
              }}
            >
              {room.code} · Copy invite
            </button>
            <div className="lobby-seats">
              {[0, 1, 2, 3].map((seat) => {
                return (
                  <PlayerBadge
                    key={seat}
                    occupant={room.seats.find((item) => {
                      return item.seat === seat
                    })}
                    active={false}
                    dealer={false}
                  />
                )
              })}
            </div>
            <p>The match starts automatically when the fourth player joins.</p>
            <button
              className="quiet-button"
              disabled={pending}
              onClick={() => {
                return void leave()
              }}
            >
              {pending ? 'Leaving…' : 'Leave table'}
            </button>
          </>
        ) : setupMode ? (
          <>
            <span className="eyebrow">House rules</span>
            <h1>Set the table.</h1>
            <p>Choose the rules for this match. We’ll remember them for your next game.</p>
            <div className="rule-options">
              <RuleToggle
                title="Stick the dealer"
                description="The dealer must choose trump in the second round."
                checked={rules.stickDealer}
                disabled={pending}
                onChange={(enabled) => {
                  return setRule('stickDealer', enabled)
                }}
              />
              <RuleToggle
                title="Require natural trump"
                description="A caller must hold a card printed in that suit. The left bower does not count."
                checked={rules.requireNaturalTrump}
                disabled={pending}
                onChange={(enabled) => {
                  return setRule('requireNaturalTrump', enabled)
                }}
              />
              <RuleToggle
                title="Partner-order loners"
                description="Allow going alone when ordering up your partner as dealer."
                checked={rules.allowAloneWhenOrderingPartner}
                disabled={pending}
                onChange={(enabled) => {
                  return setRule('allowAloneWhenOrderingPartner', enabled)
                }}
              />
              <RuleToggle
                title="Farmer's hand"
                description="Swap three 9s or three 10s for the face-down kitty, then pass unless stuck as dealer."
                checked={rules.allowFarmersHand}
                disabled={pending}
                onChange={(enabled) => {
                  return setRule('allowFarmersHand', enabled)
                }}
              />
            </div>
            <button
              className="primary-button"
              disabled={pending}
              onClick={() => {
                return void run(() => {
                  return setupMode === 'single-player'
                    ? createSinglePlayerRoomFn({ data: { rules } })
                    : setupMode === 'partner'
                      ? startPartyRoomFn({ data: { rules } })
                      : createRoomFn({ data: { rules } })
                })
              }}
            >
              {pending
                ? 'Starting…'
                : setupMode === 'single-player' || setupMode === 'partner'
                  ? 'Start game'
                  : 'Create table'}
            </button>
            <button
              className="quiet-button"
              disabled={pending}
              onClick={() => {
                return setSetupMode(null)
              }}
            >
              Back
            </button>
          </>
        ) : party ? (
          <>
            <span className="eyebrow">Your partnership</span>
            <h1>
              {party.members.length === 2 ? 'Your partner is ready.' : 'Invite your partner.'}
            </h1>
            <div className="party-members">
              {party.members.map((member) => {
                return (
                  <div key={member.userId}>
                    <span className="avatar">{member.name.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{member.name}</strong>
                      <small>
                        {member.userId === party.ownerUserId ? 'Party creator' : 'Partner'}
                      </small>
                    </span>
                  </div>
                )
              })}
            </div>
            {party.members.length === 1 && (
              <>
                <button
                  className="room-code large"
                  onClick={() => {
                    return void navigator.clipboard.writeText(
                      `${window.location.origin}/partners/${party.inviteCode}`,
                    )
                  }}
                >
                  Copy partner invite
                </button>
                <p>The link is single-use. Your partner will be asked to sign in before joining.</p>
              </>
            )}
            {party.members.length === 2 && party.ownerUserId === userId && (
              <button
                className="primary-button"
                disabled={pending}
                onClick={() => {
                  return setSetupMode('partner')
                }}
              >
                Play two bots
              </button>
            )}
            {party.members.length === 2 && party.ownerUserId !== userId && (
              <p>Waiting for the party creator to start the match.</p>
            )}
            <button
              className="quiet-button"
              disabled={pending}
              onClick={() => {
                return void leavePartnership()
              }}
            >
              {pending ? 'Leaving…' : 'Leave partnership'}
            </button>
          </>
        ) : mode === null ? (
          <>
            <span className="eyebrow">Choose a mode</span>
            <h1>How do you want to play?</h1>
            <p>Play against bots, team up with a partner, or invite four players to a table.</p>
            <div className="mode-options">
              <button
                className="mode-option"
                disabled={pending}
                onClick={() => {
                  return setSetupMode('single-player')
                }}
              >
                <strong>Single player</strong>
                <span>You and three bots</span>
              </button>
              <button
                className="mode-option"
                disabled={pending}
                onClick={() => {
                  return void createPartnership()
                }}
              >
                <strong>Play with a partner</strong>
                <span>Your duo against two bots</span>
              </button>
              <button
                className="mode-option"
                onClick={() => {
                  return setMode('multiplayer')
                }}
              >
                <strong>Multiplayer</strong>
                <span>Four online players</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="eyebrow">Multiplayer Euchre</span>
            <h1>Pull up a chair.</h1>
            <p>Create a private table or enter a six-character invite code.</p>
            <button
              className="primary-button"
              disabled={pending}
              onClick={() => {
                return setSetupMode('multiplayer')
              }}
            >
              Create a table
            </button>
            <form
              className="join-form"
              onSubmit={(event) => {
                event.preventDefault()
                void run(() => {
                  return joinRoomFn({ data: { code } })
                })
              }}
            >
              <input
                value={code}
                onChange={(event) => {
                  return setCode(event.target.value.toUpperCase())
                }}
                placeholder="INVITE"
                maxLength={6}
                required
              />
              <button className="quiet-button" disabled={pending}>
                Join
              </button>
            </form>
            <button
              className="quiet-button"
              disabled={pending}
              onClick={() => {
                return setMode(null)
              }}
            >
              Back to game modes
            </button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </section>
    </main>
  )
}

function GameTable({
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
            {([0, 1, 2, 3] as Player[]).map((relative) => {
              const player = playerAt(viewer, relative)
              const occupant = room.seats.find((seat) => {
                return seat.seat === player
              })
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
                      ) : room.hostUserId ===
                        room.seats.find((seat) => {
                          return seat.seat === viewer
                        })?.userId ? (
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
                <h2>
                  {
                    room.seats.find((seat) => {
                      return seat.seat === room.disconnectVote?.disconnectedSeat
                    })?.name
                  }{' '}
                  disconnected
                </h2>
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

export default function App() {
  const { data: session, isPending } = authClient.useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const { code: gameCode } = useParams({ strict: false })
  const [room, setRoom] = useState<RoomView | null>(null)
  const [party, setParty] = useState<PartyView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const roomId = room?.id
  const updateRoom = useCallback(
    (next: RoomView) => {
      setRoom((current) => {
        return acceptRoomUpdate(current, next)
      })
      if (window.location.pathname !== `/games/${next.code}`) {
        void navigate({ to: '/games/$code', params: { code: next.code }, replace: true })
      }
    },
    [navigate],
  )
  const leaveRoom = (leftParty = false) => {
    setRoom(null)
    if (leftParty) {
      setParty(null)
    }
    void navigate({ to: '/', replace: true })
  }

  useEffect(() => {
    if (!session || loaded) {
      return
    }
    const legacyInvite = new URLSearchParams(window.location.search).get('room')
    const partnerInvite = location.pathname.startsWith('/partners/') ? gameCode : undefined
    const tableInvite = location.pathname.startsWith('/games/') ? gameCode : legacyInvite
    const load = async () => {
      if (partnerInvite) {
        try {
          setParty(await joinPartyFn({ data: { inviteCode: partnerInvite } }))
        } catch {
          setLoadError('That partner invite is invalid or has already been used.')
        } finally {
          await navigate({ to: '/', replace: true })
        }
      }
      const [roomResult, partyResult] = await Promise.allSettled([
        tableInvite ? joinRoomFn({ data: { code: tableInvite } }) : getCurrentRoomFn(),
        getCurrentPartyFn(),
      ])
      if (roomResult.status === 'fulfilled' && roomResult.value) {
        updateRoom(roomResult.value)
      }
      if (partyResult.status === 'fulfilled') {
        setParty(partyResult.value)
      }
      if (roomResult.status === 'rejected') {
        setLoadError(
          tableInvite ? 'Could not join that table.' : 'Could not load your current game.',
        )
      } else if (partyResult.status === 'rejected') {
        setLoadError('Could not load your partnership.')
      }
    }
    void load().finally(() => {
      return setLoaded(true)
    })
  }, [gameCode, loaded, location.pathname, navigate, session, updateRoom])

  useEffect(() => {
    if (!party || room) {
      return
    }
    const refresh = () => {
      return void Promise.all([getCurrentPartyFn(), getCurrentRoomFn()]).then(
        ([nextParty, nextRoom]) => {
          setParty(nextParty)
          if (nextRoom) {
            updateRoom(nextRoom)
          }
        },
      )
    }
    const timer = window.setInterval(refresh, 2_000)
    return () => {
      return window.clearInterval(timer)
    }
  }, [party, room, updateRoom])

  useEffect(() => {
    if (!roomId) {
      return
    }
    const events = new EventSource(`/api/tables/${roomId}/events`)
    events.addEventListener('room', (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RoomView
      setRoom((current) => {
        return acceptRoomUpdate(current, next)
      })
    })
    events.addEventListener('gone', () => {
      setRoom(null)
      void getCurrentPartyFn().then(setParty)
      void navigate({ to: '/', replace: true })
    })
    return () => {
      return events.close()
    }
  }, [navigate, roomId])

  if (isPending) {
    return (
      <main className="auth-shell">
        <span className="eyebrow">Loading table…</span>
      </main>
    )
  }
  if (!session) {
    return <AuthScreen />
  }
  if (!loaded) {
    return (
      <main className="auth-shell">
        <span className="eyebrow">Finding your seat…</span>
      </main>
    )
  }
  if (!room || room.status === 'lobby' || !room.game) {
    return (
      <Lobby
        room={room}
        party={party}
        initialError={loadError}
        onRoom={updateRoom}
        onParty={setParty}
        onLeave={() => {
          return leaveRoom()
        }}
        userId={session.user.id}
        userName={session.user.name}
      />
    )
  }
  return <GameTable room={room} onRoom={updateRoom} onLeave={leaveRoom} />
}
