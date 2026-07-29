import { GameTable } from './components/GameTable'
import { Lobby } from './components/Lobby'
import { useAuthenticatedApp } from './components/AuthenticatedAppProvider'
import './App.css'

export default function App() {
  const { session, room, party, loadError, openRoom, setParty, leaveRoom } = useAuthenticatedApp()

  if (!room || room.status === 'lobby' || !room.game) {
    return (
      <Lobby
        room={room}
        party={party}
        initialError={loadError}
        onRoom={openRoom}
        onParty={setParty}
        onLeave={leaveRoom}
        userId={session.user.id}
        userName={session.user.name}
      />
    )
  }

  return <GameTable room={room} onRoom={openRoom} onLeave={leaveRoom} />
}
