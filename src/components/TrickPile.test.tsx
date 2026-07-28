import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TrickPile } from './TrickPile'

it('shows stacks for legacy tricks without recorded cards', () => {
  const markup = renderToStaticMarkup(<TrickPile trickCount={2} tricks={[]} onOpen={() => {}} />)

  expect(markup.match(/class="trick-stack"/g)).toHaveLength(2)
})
