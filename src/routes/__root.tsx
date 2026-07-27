import { createRootRoute } from '@tanstack/react-router'
import { RootComponent } from '../components/RootComponent'
import '../index.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#0d1b21' },
      { name: 'description', content: 'Private four-player Euchre tables. Deal a hand with friends in seconds.' },
      { title: 'Euchs.xyz' },
    ],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  }),
  component: RootComponent,
})
