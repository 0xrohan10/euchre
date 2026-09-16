import { cardBackImage, scoreFiveImages } from '../card-assets'

export function FiveScore({
  score,
  team,
  isViewer,
  label,
}: {
  score: number
  team: 0 | 1
  isViewer: boolean
  label?: string
}) {
  const teamName = team === 0 ? 'Black team' : 'Red team'
  const visibleName = label ?? teamName
  const accessibleName = label ? `${label}, ${teamName}` : teamName
  const face = scoreFiveImages[team]
  const displayScore = Math.min(score, 10)
  const isWinning = score >= 10
  // The lower card counts up to four before the covering card turns face up.
  // From six through nine, the cover shows five and the lower card shows the
  // additional pips.
  const lowerExposedPips = displayScore < 5 ? displayScore : displayScore > 5 ? displayScore - 5 : 0
  const coverExposedPips = displayScore >= 5 ? 5 : 0
  const scoreDescription = isWinning
    ? `${accessibleName}: ${score} points. Winning score; the scoring fives show up to 10 points.`
    : `${accessibleName}: ${score} points. The scoring fives expose ${lowerExposedPips} pips on the lower five and ${coverExposedPips} pips on the covering five.`
  const clarificationId = `score-fives-note-${team}`

  return (
    <section
      className={`score-team team-${team === 0 ? 'black' : 'red'}${isWinning ? ' score-winning' : ''}`}
      aria-label={scoreDescription}
      aria-describedby={isWinning ? clarificationId : undefined}
      data-score={score}
      data-score-state={isWinning ? 'winning' : 'in-progress'}
    >
      <div className="score-team-heading">
        <span className="team-name">
          <i />
          {visibleName}
          {isViewer && <em>You</em>}
        </span>
        <strong>
          {score}
          <small>/10</small>
        </strong>
      </div>
      <div className="score-fives" key={score} data-score-display={displayScore}>
        <div className={`score-five-stack score-${displayScore}`} data-score-layout="two-fives">
          <img
            className="score-five lower"
            src={score === 0 ? cardBackImage : face}
            alt=""
            aria-hidden="true"
            data-five-position="lower"
            data-exposed-pips={lowerExposedPips}
            data-face-up={displayScore > 0}
          />
          <img
            className="score-five cover"
            src={coverExposedPips === 0 ? cardBackImage : face}
            alt=""
            aria-hidden="true"
            data-five-position="cover"
            data-exposed-pips={coverExposedPips}
            data-face-up={coverExposedPips > 0}
          />
        </div>
      </div>
      {isWinning && (
        <p className="score-fives-note" id={clarificationId} data-score-clarification>
          Winning score: {score}. Fives show up to 10.
        </p>
      )}
    </section>
  )
}
