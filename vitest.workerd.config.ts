import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/server/workerd-test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-07-27',
        durableObjects: {
          LIVE_STREAM_ADMISSION: 'LiveStreamAdmissionGate',
          ROOM_COORDINATOR: 'RoomCoordinator',
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.workerd.test.ts'],
    server: { deps: { inline: ['pg'] } },
  },
})
