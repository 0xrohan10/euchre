import { cp } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

function thirdPartyLicenses(): Plugin {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    async writeBundle(options) {
      if (options.dir && path.basename(options.dir) === 'client') {
        await cp(
          path.resolve(import.meta.dirname, 'LICENSES'),
          path.join(options.dir, 'LICENSES'),
          {
            recursive: true,
          },
        )
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const cloudflarePlugins =
    mode === 'test' ? [] : [cloudflare({ viteEnvironment: { name: 'ssr' } })]

  return {
    plugins: [
      ...cloudflarePlugins,
      tanstackStart(),
      viteReact(),
      tailwindcss(),
      thirdPartyLicenses(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        ...(mode === 'test'
          ? {
              'cloudflare:workers': path.resolve(
                import.meta.dirname,
                'src/test/cloudflare-workers.ts',
              ),
            }
          : {}),
      },
    },
  }
})
