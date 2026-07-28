import { useEffect, useState } from 'react'
import type { GameHistorySummary } from '../game/history'
import { authClient } from '../lib/auth-client'
import { getGameHistoryFn } from '../server/game.functions'
import { AuthScreen } from './AuthScreen'
import { Brand } from './Brand'

function teamName(history: GameHistorySummary, team: 0 | 1) {
  return history.seats
    .filter((seat) => {
      return seat.seat % 2 === team
    })
    .map((seat) => {
      return seat.name
    })
    .join(' & ')
}

function ruleSummary(history: GameHistorySummary) {
  return [
    history.rules.stickDealer ? 'Stick dealer' : 'Dealer may pass',
    history.rules.requireNaturalTrump ? 'Natural trump' : 'Any trump',
    history.rules.allowAloneWhenOrderingPartner ? 'Partner orders alone' : null,
    history.rules.allowFarmersHand ? "Farmer's hand" : null,
  ]
    .filter(Boolean)
    .join(' / ')
}

export function GameHistory() {
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const [history, setHistory] = useState<GameHistorySummary[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) {
      return
    }
    void getGameHistoryFn()
      .then(setHistory)
      .catch(() => {
        setError('Could not load your game history.')
      })
  }, [session])

  if (sessionPending) {
    return (
      <main className="auth-shell">
        <span className="eyebrow">Loading history...</span>
      </main>
    )
  }
  if (!session) {
    return <AuthScreen />
  }

  return (
    <main className="history-shell">
      <header className="app-header">
        <Brand />
        <a className="quiet-button" href="/">
          Back to table
        </a>
      </header>
      <section className="history-page">
        <div className="history-heading">
          <span className="eyebrow">Your record</span>
          <h1>Game history</h1>
          <p>Your 50 most recent completed matches.</p>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : history === null ? (
          <p className="history-empty">Loading completed matches...</p>
        ) : history.length === 0 ? (
          <div className="history-empty">
            <strong>No completed games yet.</strong>
            <span>Finish a match and it will appear here.</span>
          </div>
        ) : (
          <ol className="history-list">
            {history.map((match) => {
              const winner = teamName(match, match.winner)
              return (
                <li className="history-match" key={match.id}>
                  <div className="history-result">
                    <span className="eyebrow">
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(match.completedAt))}
                    </span>
                    <strong>{winner} won</strong>
                    <span>
                      {match.handCount} {match.handCount === 1 ? 'hand' : 'hands'} /{' '}
                      {ruleSummary(match)}
                    </span>
                  </div>
                  <div
                    className="history-score"
                    aria-label={`Final score ${match.score[0]} to ${match.score[1]}`}
                  >
                    <span>{match.score[0]}</span>
                    <i>&ndash;</i>
                    <span>{match.score[1]}</span>
                  </div>
                  <div className="history-teams">
                    <span>{teamName(match, 0)}</span>
                    <span>{teamName(match, 1)}</span>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </main>
  )
}
