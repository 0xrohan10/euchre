import { useState } from 'react'
import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import { authClient } from '../lib/auth-client'
import type { GameRules } from '../game/rules'
import type { PartyView, RoomView } from '../multiplayer'
import {
  createPartyFn,
  createRoomFn,
  createSinglePlayerRoomFn,
  joinRoomFn,
  leavePartyFn,
  leaveRoomFn,
  startPartyRoomFn,
} from '../server/game.functions'
import { Brand } from './Brand'
import { HeaderMenu } from './HeaderMenu'
import { HowToPlay } from './HowToPlay'
import { PlayerBadge } from './PlayerBadge'
import { RuleToggle } from './RuleToggle'
import { loadStoredRules, RULES_STORAGE_KEY } from './rules-storage'
import { SEAT_ORDER, seatsByNumber } from './seats'

export function Lobby({
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
  const navigate = useNavigate()
  const router = useRouter()
  const [mode, setMode] = useState<'multiplayer' | null>(null)
  const [setupMode, setSetupMode] = useState<'single-player' | 'multiplayer' | 'partner' | null>(
    null,
  )
  const [rules, setRules] = useState<GameRules>(loadStoredRules)
  const [code, setCode] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [pending, setPending] = useState(false)
  const lobbySeats = room ? seatsByNumber(room.seats) : null

  function setRule(rule: keyof GameRules, enabled: boolean) {
    setRules((current) => {
      const next = { ...current, [rule]: enabled }
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(next))
      localStorage.removeItem('kitty-rules')
      return next
    })
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
        <HeaderMenu>
          <span className="eyebrow header-user">{userName}</span>
          <Link className="quiet-button" to="/history">
            Game history
          </Link>
          <HowToPlay />
          <button
            className="quiet-button"
            onClick={() => {
              return void authClient.signOut().then(async () => {
                await navigate({ to: '/sign-in', replace: true })
                await router.invalidate()
              })
            }}
          >
            Sign out
          </button>
        </HeaderMenu>
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
              {SEAT_ORDER.map((seat) => {
                return (
                  <PlayerBadge
                    key={seat}
                    occupant={lobbySeats?.get(seat)}
                    active={false}
                    dealer={false}
                    showConnection
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
