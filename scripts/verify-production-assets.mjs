import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { cardFiles, outputDirectory, root } from './card-assets.mjs'
import { requiredLicenseFiles, verifyLegalAssets } from './legal-assets.mjs'

const clientDirectory = path.join(root, 'dist/client')
const deployedAssetsDirectory = path.join(clientDirectory, 'assets')
const fontDirectory = path.join(root, 'src/assets/fonts')
const licenseDirectory = path.join(root, 'LICENSES')
const expectedHeaders = `/assets/*
  Cache-Control: public, max-age=31536000, immutable
`

async function filesRecursively(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await filesRecursively(path.join(directory, entry.name), relative)))
    } else {
      files.push(relative)
    }
  }
  return files
}

async function assertEqualFiles(source, deployed) {
  const [sourceContents, deployedContents] = await Promise.all([
    readFile(source),
    readFile(deployed),
  ])
  if (!sourceContents.equals(deployedContents)) {
    throw new Error(
      `${path.relative(root, deployed)} does not match ${path.relative(root, source)}`,
    )
  }
}

async function assertHashedAsset(sourceDirectory, file, deployedFiles) {
  const extension = path.extname(file)
  const basename = path.basename(file, extension)
  const matches = deployedFiles.filter((candidate) => {
    return candidate.startsWith(`${basename}-`) && candidate.endsWith(extension)
  })
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one deployed ${file}, found ${matches.length}`)
  }
  await assertEqualFiles(
    path.join(sourceDirectory, file),
    path.join(deployedAssetsDirectory, matches[0]),
  )
}

const deployedAssets = await readdir(deployedAssetsDirectory)
for (const file of cardFiles) {
  await assertHashedAsset(outputDirectory, file, deployedAssets)
}

const fontFiles = (await readdir(fontDirectory)).filter((file) => {
  return file.endsWith('.woff2')
})
for (const file of fontFiles) {
  await assertHashedAsset(fontDirectory, file, deployedAssets)
}

const licenseFiles = await filesRecursively(licenseDirectory)
const deployedLicenseDirectory = path.join(clientDirectory, 'LICENSES')
const deployedLicenseFiles = await filesRecursively(deployedLicenseDirectory)
if (licenseFiles.sort().join('\n') !== requiredLicenseFiles.join('\n')) {
  throw new Error('LICENSES does not contain exactly the required legal and provenance files')
}
if (deployedLicenseFiles.sort().join('\n') !== requiredLicenseFiles.join('\n')) {
  throw new Error(
    'Deployed output does not contain exactly the required legal and provenance files',
  )
}
for (const file of licenseFiles) {
  await assertEqualFiles(
    path.join(licenseDirectory, file),
    path.join(deployedLicenseDirectory, file),
  )
}
await verifyLegalAssets(deployedLicenseDirectory)

const deployedHeaders = await readFile(path.join(clientDirectory, '_headers'), 'utf8')
if (deployedHeaders !== expectedHeaders) {
  throw new Error('Deployed output does not set immutable caching for fingerprinted assets')
}

console.log(
  `Verified production output: ${cardFiles.length} cards, ${fontFiles.length} fonts, and ${licenseFiles.length} license/provenance files.`,
)
