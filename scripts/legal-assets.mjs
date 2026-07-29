import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const requiredLicenseFiles = [
  'Inter-OFL-1.1.txt',
  'Inter-PROVENANCE.txt',
  path.join('vectorized-playing-cards', 'ATTRIBUTION.txt'),
  path.join('vectorized-playing-cards', 'AUTHORS.txt'),
  path.join('vectorized-playing-cards', 'GPL-3.0.txt'),
  path.join('vectorized-playing-cards', 'LGPL-3.0.txt'),
].sort()

const canonicalHashes = {
  'Inter-OFL-1.1.txt': '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',
  [path.join('vectorized-playing-cards', 'AUTHORS.txt')]:
    'b88710add346fe19380e51f64c383c538e05e28b1981edddf98c6c2de960b97b',
  [path.join('vectorized-playing-cards', 'GPL-3.0.txt')]:
    '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
  [path.join('vectorized-playing-cards', 'LGPL-3.0.txt')]:
    'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118',
}

const attributionFields = {
  'Upstream-Name': 'Vectorized Playing Cards',
  'Upstream-Version': '1.3',
  'Upstream-Source': 'http://code.google.com/p/vectorized-playing-cards/',
  'Upstream-Copyright': 'Copyright 2011 - Chris Aguilar',
  'Upstream-License': 'LGPL-3.0-only',
  'Distribution-Package': 'cardsJS',
  'Distribution-Version': '1.1.1',
  'Distribution-Source': 'https://registry.npmjs.org/cardsJS/-/cardsJS-1.1.1.tgz',
  'Distribution-Integrity-SHA-512':
    'S8J1GsZp9Wimj1jBu6jhH8pHNuOvkA7uryP7YeeaMP8o02g86rdTkXes0rAb/y8ShdCx5JDwg116/hMEGtAuJw==',
  'Derivative-Date': '2026-07-28',
  'Derivative-Tool': 'SVGO 4.0.0',
  Modifications:
    'Selected the 27 cards used by Euchre and deterministically optimized their SVG markup; rendered artwork pixels are unchanged.',
  'Corresponding-Source':
    'The complete upstream source is available from Distribution-Source above.',
  Reproduction: 'Run `bun run assets:cards`.',
  Verification: 'Run `bun run assets:verify` to compare rendered pixels with the source.',
}

const provenanceFields = {
  Asset: 'Inter variable and static upright WOFF2 files',
  Version: '4.1',
  Copyright: 'Copyright (c) 2016 The Inter Project Authors',
  License: 'SIL Open Font License 1.1 (Inter-OFL-1.1.txt)',
  Release: 'https://github.com/rsms/inter/releases/tag/v4.1',
  Source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
  'Archive-Paths':
    'web/InterVariable.woff2 and web/Inter-{Thin,ExtraLight,Light,Regular,Medium,SemiBold,Bold,ExtraBold,Black}.woff2',
  'Archive-SHA-256': '9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e',
  'Variable-Font-SHA-256': '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
  Modifications: 'None; files are copied unchanged from the release archive.',
  Verification: 'The SHA-256 of every vendored WOFF2 is pinned by scripts/verify-card-assets.mjs.',
}

async function assertSha256(file, expected) {
  const contents = await readFile(file)
  const actual = createHash('sha256').update(contents).digest('hex')
  if (actual !== expected) {
    throw new Error(`${file} has SHA-256 ${actual}, expected canonical hash ${expected}`)
  }
}

async function assertFields(file, expectedFields) {
  const contents = await readFile(file, 'utf8')
  const actualFields = new Map()
  for (const line of contents.trimEnd().split('\n')) {
    const separator = line.indexOf(': ')
    if (separator < 1) {
      throw new Error(`${file} contains an invalid structured field: ${line}`)
    }
    const name = line.slice(0, separator)
    const value = line.slice(separator + 2)
    if (!value || actualFields.has(name)) {
      throw new Error(`${file} contains an empty or duplicate ${name} field`)
    }
    actualFields.set(name, value)
  }
  if (actualFields.size !== Object.keys(expectedFields).length) {
    throw new Error(`${file} does not contain exactly the required structured fields`)
  }
  for (const [name, expected] of Object.entries(expectedFields)) {
    if (actualFields.get(name) !== expected) {
      throw new Error(`${file} has an invalid or missing ${name} field`)
    }
  }
}

export async function verifyLegalAssets(directory) {
  for (const [file, expected] of Object.entries(canonicalHashes)) {
    await assertSha256(path.join(directory, file), expected)
  }
  await assertFields(
    path.join(directory, 'vectorized-playing-cards', 'ATTRIBUTION.txt'),
    attributionFields,
  )
  await assertFields(path.join(directory, 'Inter-PROVENANCE.txt'), provenanceFields)
}
