import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { optimize } from 'svgo'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sourceDirectory = path.join(root, 'node_modules/cardsJS/cards')
export const outputDirectory = path.join(root, 'src/assets/cards')

export const cardFiles = [
  '9C.svg',
  '9D.svg',
  '9H.svg',
  '9S.svg',
  '10C.svg',
  '10D.svg',
  '10H.svg',
  '10S.svg',
  'JC.svg',
  'JD.svg',
  'JH.svg',
  'JS.svg',
  'QC.svg',
  'QD.svg',
  'QH.svg',
  'QS.svg',
  'KC.svg',
  'KD.svg',
  'KH.svg',
  'KS.svg',
  'AC.svg',
  'AD.svg',
  'AH.svg',
  'AS.svg',
  '5D.svg',
  '5S.svg',
  'Blue_Back.svg',
]

const cardSourceHashes = {
  '9C.svg': 'e4cb910fa1f8dfec7b7a63859faa39c8307ff167aed282c4691a56b31baec537',
  '9D.svg': '2fbbb309f3fc4a4354ec40f76fb3b0c43eabc0e9a7dbc71117ac243d6aa05edc',
  '9H.svg': 'ea6428fe885ec6932c27af4b2cb74462e247586183733410365f0c2c7da3ce7d',
  '9S.svg': '0140833c814f064c81927fe32c52ed7b4bfcc924d8154d74de4dac06a91f5808',
  '10C.svg': 'd41acdee9c4e0e891a2d6d46438c362647547189b077ee2286d6d35f60c0a3ce',
  '10D.svg': 'c3fefdf208bd6ba3a8c08da7b087f12cb732c1c389b803a03a5c6bf950fee1d5',
  '10H.svg': 'e9881118c001e6c0c45e62ce8872229e945a4dbdf249675b8eca59d2a96b8eb8',
  '10S.svg': '29f80a19aef8d870f0c45136ebd516a9d09bdfddd666918a259f542c89ec3348',
  'JC.svg': 'd3e947d78e0974772df3760be379cbc70bda79da802ba800f107e384a7893087',
  'JD.svg': 'c0ead7b4064fbc7ea1acd0b2f41ad4b39f8a21bcb3cd2ee846b6f9100567b3ed',
  'JH.svg': 'be50638b046a7c1ecddd2c4818c6235561618f32b4227d6230fad43ec894631d',
  'JS.svg': '3fc393f610138d116d64ed54cd5a845970b4e5561374ebe7816c2c9608c3cad6',
  'QC.svg': '004244fbdcbaab7b94c2afbb4758856016b0ae5dd516165f5f4f0497dc653544',
  'QD.svg': 'acdab8ebd875aee2e54969d39a896e0ecc91b77bf7cd0f813c742a2946a8b9ef',
  'QH.svg': '4308d7af3445924ea5a3df26363dfd1627dfad4bf0264d2e1559a068bf14dcc2',
  'QS.svg': 'c56e3b28af60955ba9f76d0be372b3393ca0e036ae13988dea8523268d7a1338',
  'KC.svg': 'efce3e359c6abc71ce9ee8e0e938a9f12603d1f4464fb3b835e0d1e2910c64b1',
  'KD.svg': '7450e66ca518ad2eb4dc26a1aaaae5bbb0f2f1170f8137337d2c1bfbfe59ce24',
  'KH.svg': 'df5d61c5fb922cdf559f6320bba4be2119e4398cba9af78b3d0017c0d5ed2213',
  'KS.svg': 'cc6a12d78d7cf93f53328b2742aadc13c6e7e9f2051ee936f1241da54f71b4c7',
  'AC.svg': 'c904da163f5c09c1ce5d0becdda0520243db829c8d89899cdf6a682053bc334a',
  'AD.svg': '20fea6b9e186a511a304d3b60cbfa99487925df9ce1ca621d53018d6dab26e34',
  'AH.svg': '43a3d61b67ddc7071e28ee100382596b9562bdda9895c263807c4555a62d30b1',
  'AS.svg': 'afdc66602825b8fd61d437a30204c968f25475425d426719ea2289e9cd71f480',
  '5D.svg': '58693ede393f9d2ac9c3a99279d46a949a59562cc8475bbb5f570f0877069b68',
  '5S.svg': '50a30eb17f260d15568fe3b32f34ca517777578b0045f41ad0d1eb5f9396d096',
  'Blue_Back.svg': '36b1505a4e83160fa10e16326eb8bb9c8aa7bad22335ccd7fa7bc773fc88d06f',
}

export const displaySizes = [
  { width: 52, height: 73 },
  { width: 56, height: 78 },
  { width: 60, height: 84 },
  { width: 64, height: 90 },
  { width: 72, height: 101 },
  { width: 108, height: 151 },
  { width: 132, height: 185 },
]
export const devicePixelRatios = [1, 2]

export async function assertPinnedSource() {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'node_modules/cardsJS/package.json'), 'utf8'),
  )
  if (packageJson.version !== '1.1.1') {
    throw new Error(`Expected cardsJS 1.1.1, received ${packageJson.version}`)
  }

  for (const file of cardFiles) {
    const source = await readFile(path.join(sourceDirectory, file))
    const actual = createHash('sha256').update(source).digest('hex')
    const expected = cardSourceHashes[file]
    if (actual !== expected) {
      throw new Error(`Upstream cardsJS 1.1.1 ${file} has SHA-256 ${actual}, expected ${expected}`)
    }
  }
}

export function optimizeCard(source, file) {
  return optimize(source, {
    path: file,
    multipass: true,
    plugins: [
      'removeDoctype',
      'removeXMLProcInst',
      'removeComments',
      'removeMetadata',
      'removeEditorsNSData',
      'removeDesc',
      'removeTitle',
      'cleanupAttrs',
      'cleanupEnableBackground',
      'collapseGroups',
      'convertColors',
      'convertStyleToAttrs',
      'minifyStyles',
      'removeEmptyAttrs',
      'removeEmptyText',
      'removeNonInheritableGroupAttrs',
      'removeUnknownsAndDefaults',
      'removeUselessDefs',
      'removeUnusedNS',
      'removeDimensions',
      'sortAttrs',
    ],
  }).data
}
