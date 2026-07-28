import { HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { InteractionSounds } from './InteractionSounds'
import { SensoryUIProvider } from './ui/sensory-ui/config/provider'

export function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <SensoryUIProvider config={{ theme: 'crisp', volume: 0.18 }}>
          <InteractionSounds />
          <Outlet />
        </SensoryUIProvider>
        <Scripts />
      </body>
    </html>
  )
}
