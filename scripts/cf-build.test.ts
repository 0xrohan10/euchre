import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Cloudflare build', () => {
  it('verifies asset provenance before migrations and the Vite build without recursion', async () => {
    const script = await readFile(new URL('./cf-build.sh', import.meta.url), 'utf8')
    const verifyIndex = script.indexOf('bun run assets:verify')
    const migrateIndex = script.indexOf('bun run db:migrate')
    const buildIndex = script.indexOf('bun run build')

    expect(verifyIndex).toBeGreaterThan(-1)
    expect(migrateIndex).toBeGreaterThan(verifyIndex)
    expect(buildIndex).toBeGreaterThan(migrateIndex)
    expect(script).not.toContain('bun run cf:build')
  })
})
