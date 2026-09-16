import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FiveScore } from './FiveScore'

function renderScore(score: number) {
  return renderToStaticMarkup(<FiveScore score={score} team={0} isViewer={false} />)
}

describe('FiveScore', () => {
  it('keeps card faces and two-five exposure accurate from zero through ten', () => {
    const expected: Array<[number, number, number, boolean, boolean]> = [
      [0, 0, 0, false, false],
      [1, 1, 0, true, false],
      [2, 2, 0, true, false],
      [3, 3, 0, true, false],
      [4, 4, 0, true, false],
      [5, 0, 5, true, true],
      [6, 1, 5, true, true],
      [7, 2, 5, true, true],
      [8, 3, 5, true, true],
      [9, 4, 5, true, true],
      [10, 5, 5, true, true],
    ]

    for (const [score, lower, cover, lowerFaceUp, coverFaceUp] of expected) {
      const markup = renderScore(score)
      expect(markup).toContain(`data-score="${score}"`)
      expect(markup).toContain(`data-five-position="lower" data-exposed-pips="${lower}"`)
      expect(markup).toContain(`data-five-position="cover" data-exposed-pips="${cover}"`)
      expect(markup).toContain(
        `data-five-position="lower" data-exposed-pips="${lower}" data-face-up="${lowerFaceUp}"`,
      )
      expect(markup).toContain(
        `data-five-position="cover" data-exposed-pips="${cover}" data-face-up="${coverFaceUp}"`,
      )
      if (score < 10) {
        expect(markup).not.toContain('data-score-state="winning"')
      }
    }
  })

  it('shows the actual winning total and clarifies the capped five display', () => {
    const markup = renderScore(12)

    expect(markup).toContain(
      'aria-label="Black team: 12 points. Winning score; the scoring fives show up to 10 points."',
    )
    expect(markup).toContain('data-score="12"')
    expect(markup).toContain('data-score-state="winning"')
    expect(markup).toContain('data-score-display="10"')
    expect(markup).toContain('Winning score: 12. Fives show up to 10.')
  })

  it('keeps team identity and viewer status accessible', () => {
    const markup = renderToStaticMarkup(<FiveScore score={7} team={1} isViewer label="Us" />)

    expect(markup).toContain('>Us<')
    expect(markup).toContain('<em>You</em>')
    expect(markup).toContain('aria-label="Us, Red team: 7 points.')
  })
})
