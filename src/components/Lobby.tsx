import { useEffect, useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  RequestDeadlineError,
  type LiveConnectionState,
  withRequestDeadline,
} from '../interaction-feedback'
import type { GameRules } from '../game/rules'
import type { PartyView, RoomView } from '../multiplayer'
import {
  createPartyFn,
  createRoomFn,
  createSinglePlayerRoomFn,
  getRoomForCreationFn,
  joinRoomFn,
  leavePartyFn,
  leaveRoomFn,
  startPartyRoomFn,
} from '../server/game.functions'
import { Brand } from './Brand'
import { ConnectionStatus } from './ConnectionStatus'
import { CopyInviteButton } from './CopyInviteButton'
import { HeaderMenu } from './HeaderMenu'
import { HowToPlay } from './HowToPlay'
import { PlayerBadge } from './PlayerBadge'
import { RuleToggle } from './RuleToggle'
import { loadStoredRules, RULES_STORAGE_KEY } from './rules-storage'
import { SEAT_ORDER, seatsByNumber } from './seats'

type LobbyOperation =
  | { type: 'open-room'; label: string }
  | { type: 'leave-room'; label: 'Leaving table…' }
  | { type: 'create-party'; label: 'Creating partnership…' }
  | { type: 'leave-party'; label: 'Leaving partnership…' }

type RoomCreationKind = 'multiplayer' | 'single-player'
type RoomCreation = {
  request: { operationId: string; rules: GameRules }
  attempts: Set<Promise<RoomView>>
  settled: boolean
}

class DefinitiveCreationRejection extends Error {
  constructor() {
    super('Room creation was rejected before commit.')
    this.name = 'DefinitiveCreationRejection'
  }
}

export function Lobby({
  room,
  party,
  initialError,
  onRoom,
  onParty,
  onLeave,
  userId,
  userName,
  connection,
  onSignOut,
}: {
  room: RoomView | null
  party: PartyView | null
  initialError?: string
  onRoom: (room: RoomView) => void
  onParty: (party: PartyView | null) => void
  onLeave: () => void
  userId: string
  userName: string
  connection: LiveConnectionState
  onSignOut: () => void
}) {
  const [mode, setMode] = useState<'multiplayer' | null>(null)
  const [setupMode, setSetupMode] = useState<'single-player' | 'multiplayer' | 'partner' | null>(
    null,
  )
  const [rules, setRules] = useState<GameRules>(loadStoredRules)
  const [code, setCode] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [operation, setOperation] = useState<LobbyOperation | null>(null)
  const [ambiguousCreation, setAmbiguousCreation] = useState<{
    kind: RoomCreationKind
    creation: RoomCreation
  } | null>(null)
  const roomCreations = useRef(new Map<RoomCreationKind, RoomCreation>())
  const errorId = useId()
  const lobbySeats = room ? seatsByNumber(room.seats) : null
  const actionsDisabled = operation !== null || (room !== null && !connection.snapshotTrusted)
  const creationRecoveryActive = ambiguousCreation !== null
  const retainedCreation =
    setupMode === 'single-player' || setupMode === 'multiplayer'
      ? ambiguousCreation?.kind === setupMode
        ? ambiguousCreation.creation
        : null
      : null
  const displayedRules = retainedCreation?.request.rules ?? rules

  useEffect(() => {
    if (room) {
      roomCreations.current.clear()
      setAmbiguousCreation(null)
    }
  }, [room])

  function setRule(rule: keyof GameRules, enabled: boolean) {
    if (retainedCreation) {
      return
    }
    setRules((current) => {
      const next = { ...current, [rule]: enabled }
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(next))
      localStorage.removeItem('kitty-rules')
      return next
    })
  }
  async function run(label: string, task: () => Promise<RoomView>, applyDeadline = true) {
    if (ambiguousCreation) {
      setError('Wait for the table request to resolve or retry it from the current setup screen.')
      return
    }
    setOperation({ type: 'open-room', label })
    setError('')
    try {
      onRoom(await (applyDeadline ? withRequestDeadline(task) : task()))
    } catch {
      setError('Could not open that table. Please try again.')
    } finally {
      setOperation(null)
    }
  }
  async function createRoom(
    kind: RoomCreationKind,
    label: string,
    create: (data: {
      operationId: string
      rules: GameRules
    }) => Promise<RoomView | { outcome: 'created'; room: RoomView } | { outcome: 'rejected' }>,
  ) {
    if (ambiguousCreation && ambiguousCreation.kind !== kind) {
      setError('Wait for the table request to resolve or retry it before starting another game.')
      return
    }
    const creation = roomCreations.current.get(kind) ?? {
      request: { operationId: crypto.randomUUID(), rules: { ...rules } },
      attempts: new Set<Promise<RoomView>>(),
      settled: false,
    }
    roomCreations.current.set(kind, creation)
    const submit = () => {
      const request = Promise.resolve().then(async () => {
        const result = await create(creation.request)
        if ('outcome' in result) {
          if (result.outcome === 'rejected') {
            throw new DefinitiveCreationRejection()
          }
          return result.room
        }
        return result
      })
      creation.attempts.add(request)
      void request.then(
        (nextRoom) => {
          if (roomCreations.current.get(kind) !== creation || creation.settled) {
            return
          }
          creation.settled = true
          roomCreations.current.delete(kind)
          setAmbiguousCreation((current) => {
            return current?.creation === creation ? null : current
          })
          onRoom(nextRoom)
        },
        async (cause) => {
          creation.attempts.delete(request)
          if (
            roomCreations.current.get(kind) !== creation ||
            creation.settled ||
            creation.attempts.size > 0
          ) {
            return
          }
          let reconciledRoom: RoomView | null = null
          try {
            reconciledRoom = await getRoomForCreationFn({
              data: { operationId: creation.request.operationId, kind },
            })
          } catch {
            // Lookup transport failure is ambiguous too; retain the operation for an identical retry.
          }
          if (roomCreations.current.get(kind) !== creation || creation.settled) {
            return
          }
          if (reconciledRoom) {
            creation.settled = true
            roomCreations.current.delete(kind)
            setAmbiguousCreation((current) => {
              return current?.creation === creation ? null : current
            })
            onRoom(reconciledRoom)
            return
          }
          if (cause instanceof DefinitiveCreationRejection) {
            roomCreations.current.delete(kind)
            setAmbiguousCreation((current) => {
              return current?.creation === creation ? null : current
            })
            setError('Could not open that table. Please try again.')
            return
          }
          setAmbiguousCreation({ kind, creation })
          setError('The table request may still have completed. Retry using the same settings.')
        },
      )
      return request
    }

    setOperation({ type: 'open-room', label })
    setError('')
    try {
      try {
        await withRequestDeadline(submit)
      } catch (cause) {
        if (!(cause instanceof RequestDeadlineError)) {
          throw cause
        }
        await withRequestDeadline(submit)
      }
    } catch (cause) {
      if (cause instanceof RequestDeadlineError || roomCreations.current.get(kind) === creation) {
        setAmbiguousCreation({ kind, creation })
        setError('The table request may still complete. Retry when ready using the same settings.')
      } else {
        setError('Could not open that table. Please try again.')
      }
    } finally {
      setOperation(null)
    }
  }
  async function leave() {
    if (!room) {
      return
    }
    setOperation({ type: 'leave-room', label: 'Leaving table…' })
    setError('')
    try {
      await withRequestDeadline(() => {
        return leaveRoomFn({ data: { roomId: room.id } })
      })
      onLeave()
    } catch {
      setError('Could not leave that table. Please try again.')
    } finally {
      setOperation(null)
    }
  }
  async function createPartnership() {
    if (ambiguousCreation) {
      setError('Wait for the table request to resolve or retry it before joining a partnership.')
      return
    }
    setOperation({ type: 'create-party', label: 'Creating partnership…' })
    setError('')
    try {
      onParty(await withRequestDeadline(createPartyFn))
    } catch {
      setError('Could not create a partnership. Please try again.')
    } finally {
      setOperation(null)
    }
  }
  async function leavePartnership() {
    setOperation({ type: 'leave-party', label: 'Leaving partnership…' })
    setError('')
    try {
      await withRequestDeadline(leavePartyFn)
      onParty(null)
      setSetupMode(null)
    } catch {
      setError('Could not leave this partnership. Please try again.')
    } finally {
      setOperation(null)
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
            disabled={operation !== null}
            onClick={() => {
              onSignOut()
            }}
          >
            Sign out
          </button>
        </HeaderMenu>
      </header>
      <section className="lobby-card" aria-busy={operation !== null}>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {operation?.label ?? ''}
        </span>
        {room ? (
          <>
            <span className="eyebrow">Invite table</span>
            <h1>Waiting for four</h1>
            <CopyInviteButton
              key={room.id}
              path={`/games/${room.code}`}
              label={`${room.code} · Copy invite`}
              className="room-code large"
            />
            <ConnectionStatus connection={connection} />
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
              disabled={actionsDisabled}
              onClick={() => {
                return void leave()
              }}
            >
              {operation?.type === 'leave-room' ? 'Leaving…' : 'Leave table'}
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
                checked={displayedRules.stickDealer}
                disabled={actionsDisabled || retainedCreation !== null}
                onChange={(enabled) => {
                  return setRule('stickDealer', enabled)
                }}
              />
              <RuleToggle
                title="Require natural trump"
                description="A caller must hold a card printed in that suit. The left bower does not count."
                checked={displayedRules.requireNaturalTrump}
                disabled={actionsDisabled || retainedCreation !== null}
                onChange={(enabled) => {
                  return setRule('requireNaturalTrump', enabled)
                }}
              />
              <RuleToggle
                title="Partner-order loners"
                description="Allow going alone when ordering up your partner as dealer."
                checked={displayedRules.allowAloneWhenOrderingPartner}
                disabled={actionsDisabled || retainedCreation !== null}
                onChange={(enabled) => {
                  return setRule('allowAloneWhenOrderingPartner', enabled)
                }}
              />
              <RuleToggle
                title="Farmer's hand"
                description="Swap three 9s or three 10s for the face-down kitty, then pass unless stuck as dealer."
                checked={displayedRules.allowFarmersHand}
                disabled={actionsDisabled || retainedCreation !== null}
                onChange={(enabled) => {
                  return setRule('allowFarmersHand', enabled)
                }}
              />
            </div>
            {retainedCreation && (
              <p>
                This table request is not confirmed yet. Stay here and retry with the same settings.
                Other table actions are locked, and a late success will open automatically.
              </p>
            )}
            <button
              className="primary-button"
              disabled={
                actionsDisabled || (creationRecoveryActive && ambiguousCreation.kind !== setupMode)
              }
              onClick={() => {
                const label = setupMode === 'multiplayer' ? 'Creating table…' : 'Starting game…'
                if (setupMode === 'partner') {
                  return void run(label, () => {
                    return startPartyRoomFn({ data: { rules: displayedRules } })
                  })
                }
                return void createRoom(setupMode, label, (data) => {
                  return setupMode === 'single-player'
                    ? createSinglePlayerRoomFn({ data })
                    : createRoomFn({ data })
                })
              }}
            >
              {operation?.type === 'open-room'
                ? operation.label
                : setupMode === 'single-player' || setupMode === 'partner'
                  ? 'Start game'
                  : 'Create table'}
            </button>
            <button
              className="quiet-button"
              disabled={actionsDisabled || creationRecoveryActive}
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
                <CopyInviteButton
                  key={party.id}
                  path={`/partners/${party.inviteCode}`}
                  label="Copy partner invite"
                  className="room-code large"
                />
                <p>The link is single-use. Your partner will be asked to sign in before joining.</p>
              </>
            )}
            {party.members.length === 2 && party.ownerUserId === userId && (
              <button
                className="primary-button"
                disabled={actionsDisabled || creationRecoveryActive}
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
              disabled={actionsDisabled}
              onClick={() => {
                return void leavePartnership()
              }}
            >
              {operation?.type === 'leave-party' ? 'Leaving…' : 'Leave partnership'}
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
                disabled={actionsDisabled || creationRecoveryActive}
                onClick={() => {
                  return setSetupMode('single-player')
                }}
              >
                <strong>Single player</strong>
                <span>You and three bots</span>
              </button>
              <button
                className="mode-option"
                disabled={actionsDisabled || creationRecoveryActive}
                onClick={() => {
                  return void createPartnership()
                }}
              >
                <strong>Play with a partner</strong>
                <span>Your duo against two bots</span>
              </button>
              <button
                className="mode-option"
                disabled={actionsDisabled || creationRecoveryActive}
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
              disabled={actionsDisabled || creationRecoveryActive}
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
                void run('Joining table…', () => {
                  return joinRoomFn({ data: { code } })
                })
              }}
            >
              <input
                disabled={actionsDisabled || creationRecoveryActive}
                value={code}
                onChange={(event) => {
                  return setCode(event.target.value.toUpperCase())
                }}
                placeholder="INVITE"
                maxLength={6}
                required
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
              />
              <button className="quiet-button" disabled={actionsDisabled || creationRecoveryActive}>
                {operation?.type === 'open-room' ? 'Joining…' : 'Join'}
              </button>
            </form>
            <button
              className="quiet-button"
              disabled={actionsDisabled || creationRecoveryActive}
              onClick={() => {
                return setMode(null)
              }}
            >
              Back to game modes
            </button>
          </>
        )}
        {error && (
          <p className="form-error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  )
}
