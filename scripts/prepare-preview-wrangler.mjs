import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'jsonc-parser'

const configPath = new URL('../wrangler.jsonc', import.meta.url)
const config = parse(await readFile(configPath, 'utf8'))

delete config.durable_objects
delete config.migrations

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
