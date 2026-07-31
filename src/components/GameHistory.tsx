import { Link } from '@tanstack/react-router'
import type { GameHistorySummary } from '../game/history'
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

export function GameHistory({ history }: { history: GameHistorySummary[] }) {
  return (
    <main className="history-shell">
      <header className="app-header">
        <Brand />
        <Link className="quiet-button" to="/">
          Back to table
        </Link>
      </header>
      <section className="history-page">
        <div className="history-heading">
          <span className="eyebrow">Your record</span>
          <h1>Game history</h1>
          <p>Your 50 most recent completed matches.</p>
        </div>
        {history.length === 0 ? (
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
