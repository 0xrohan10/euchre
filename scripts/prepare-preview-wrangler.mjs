import { readFile, writeFile } from 'node:fs/promises'

const configPath = new URL('../wrangler.jsonc', import.meta.url)
const config = JSON.parse(await readFile(configPath, 'utf8'))

delete config.durable_objects
delete config.migrations

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
