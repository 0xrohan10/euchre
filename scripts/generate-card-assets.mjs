import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  assertPinnedSource,
  cardFiles,
  optimizeCard,
  outputDirectory,
  sourceDirectory,
} from './card-assets.mjs'

await assertPinnedSource()
await mkdir(outputDirectory, { recursive: true })

for (const file of cardFiles) {
  const source = await readFile(path.join(sourceDirectory, file), 'utf8')
  await writeFile(path.join(outputDirectory, file), optimizeCard(source, file))
}

console.log(`Generated ${cardFiles.length} optimized card assets.`)
