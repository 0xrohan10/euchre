import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import {
  assertPinnedSource,
  cardFiles,
  devicePixelRatios,
  displaySizes,
  optimizeCard,
  outputDirectory,
  sourceDirectory,
} from './card-assets.mjs'
import { verifyLegalAssets } from './legal-assets.mjs'

function renderAtSize(svg, width, height, dpr) {
  const encodedSvg = Buffer.from(svg).toString('base64')
  const renderedWidth = width * dpr
  const renderedHeight = height * dpr
  const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${renderedWidth}" height="${renderedHeight}"><image href="data:image/svg+xml;base64,${encodedSvg}" width="${renderedWidth}" height="${renderedHeight}"/></svg>`
  return new Resvg(wrapper).render().pixels
}

async function assertSha256(file, expected) {
  const contents = await readFile(file)
  const actual = createHash('sha256').update(contents).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `${path.relative(process.cwd(), file)} has SHA-256 ${actual}, expected ${expected}`,
    )
  }
}

await assertPinnedSource()
const fontHashes = {
  'Inter-Thin.woff2': '70ca998635d9fc627dede8108f04d0989e6e03346183f0ad0917723e790f6973',
  'Inter-ExtraLight.woff2': 'ba4fc81dbb25871f1bcabc664b1e37703fca0a05f7248a923e7db497c6d211cc',
  'Inter-Light.woff2': 'e111a1e2ad914ccda9179b95e83fb10234dd52a1932e0b93c480476227983fd9',
  'Inter-Regular.woff2': 'e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085',
  'Inter-Medium.woff2': '0ff3e94614e1493eb556314fd247ae6c4a85a7783b4cc86be539940cf83f2a48',
  'Inter-SemiBold.woff2': '5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301',
  'Inter-Bold.woff2': 'fa888127b6da015b65569f0351f3b5c391ad928904951f1c20e9f8462a8d95ea',
  'Inter-ExtraBold.woff2': '6f75025856f8db1b2186e9cb89be9de9894932c8b7b20f4df5e65916ff714e34',
  'Inter-Black.woff2': '12ed0eed6749099b46c7b2e8198dc30c2d7e0f2a4e5fb1d12f0b6ae2c4f33cc4',
  'InterVariable.woff2': '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
}
const fontDirectory = path.join(outputDirectory, '../fonts')
const actualFontFiles = (await readdir(fontDirectory)).filter((file) => {
  return file.endsWith('.woff2')
})
if (actualFontFiles.sort().join('\n') !== Object.keys(fontHashes).sort().join('\n')) {
  throw new Error('src/assets/fonts must contain exactly the verified Inter 4.1 WOFF2 files')
}
for (const [file, expected] of Object.entries(fontHashes)) {
  await assertSha256(path.join(fontDirectory, file), expected)
}
await verifyLegalAssets(path.join(outputDirectory, '../../../LICENSES'))

const actualFiles = (await readdir(outputDirectory)).filter((file) => {
  return file.endsWith('.svg')
})
if (actualFiles.sort().join('\n') !== [...cardFiles].sort().join('\n')) {
  throw new Error('src/assets/cards must contain exactly the configured 27 SVG files')
}

let sourceBytes = 0
let optimizedBytes = 0
let renderCount = 0

for (const file of cardFiles) {
  const source = await readFile(path.join(sourceDirectory, file), 'utf8')
  const output = await readFile(path.join(outputDirectory, file), 'utf8')
  const expected = optimizeCard(source, file)
  if (output !== expected) {
    throw new Error(`${file} is stale; run bun run assets:cards`)
  }

  sourceBytes += Buffer.byteLength(source)
  optimizedBytes += Buffer.byteLength(output)

  for (const { width, height } of displaySizes) {
    for (const dpr of devicePixelRatios) {
      const sourcePixels = renderAtSize(source, width, height, dpr)
      const outputPixels = renderAtSize(output, width, height, dpr)
      if (!Buffer.from(sourcePixels).equals(Buffer.from(outputPixels))) {
        throw new Error(`${file} changed pixels at ${width}x${height}px and DPR ${dpr}`)
      }
      renderCount += 1
    }
  }
}

if (optimizedBytes >= sourceBytes) {
  throw new Error('Optimized cards did not reduce aggregate bytes')
}

const reduction = sourceBytes - optimizedBytes
console.log(
  `Verified ${Object.keys(fontHashes).length} Inter 4.1 fonts and ${cardFiles.length} cards across ${renderCount} renders: ${sourceBytes} -> ${optimizedBytes} bytes (-${reduction}, ${((reduction / sourceBytes) * 100).toFixed(1)}%).`,
)
