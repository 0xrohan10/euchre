import { cardBackImage, scoreFiveImages } from '../card-assets'

export function FiveScore({
  score,
  team,
  isViewer,
}: {
  score: number
  team: 0 | 1
  isViewer: boolean
}) {
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
