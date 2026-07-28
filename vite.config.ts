import path from 'node:path'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const cloudflarePlugins =
    mode === 'test' ? [] : [cloudflare({ viteEnvironment: { name: 'ssr' } })]

  return {
    plugins: [...cloudflarePlugins, tanstackStart(), viteReact(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
      },
    },
  }
})
