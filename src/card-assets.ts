import aceClubs from './assets/cards/AC.svg?no-inline'
import aceDiamonds from './assets/cards/AD.svg?no-inline'
import aceHearts from './assets/cards/AH.svg?no-inline'
import aceSpades from './assets/cards/AS.svg?no-inline'
import blueCardBack from './assets/cards/Blue_Back.svg?no-inline'
import fiveDiamonds from './assets/cards/5D.svg?no-inline'
import fiveSpades from './assets/cards/5S.svg?no-inline'
import jackClubs from './assets/cards/JC.svg?no-inline'
import jackDiamonds from './assets/cards/JD.svg?no-inline'
import jackHearts from './assets/cards/JH.svg?no-inline'
import jackSpades from './assets/cards/JS.svg?no-inline'
import kingClubs from './assets/cards/KC.svg?no-inline'
import kingDiamonds from './assets/cards/KD.svg?no-inline'
import kingHearts from './assets/cards/KH.svg?no-inline'
import kingSpades from './assets/cards/KS.svg?no-inline'
import queenClubs from './assets/cards/QC.svg?no-inline'
import queenDiamonds from './assets/cards/QD.svg?no-inline'
import queenHearts from './assets/cards/QH.svg?no-inline'
import queenSpades from './assets/cards/QS.svg?no-inline'
import tenClubs from './assets/cards/10C.svg?no-inline'
import tenDiamonds from './assets/cards/10D.svg?no-inline'
import tenHearts from './assets/cards/10H.svg?no-inline'
import tenSpades from './assets/cards/10S.svg?no-inline'
import nineClubs from './assets/cards/9C.svg?no-inline'
import nineDiamonds from './assets/cards/9D.svg?no-inline'
import nineHearts from './assets/cards/9H.svg?no-inline'
import nineSpades from './assets/cards/9S.svg?no-inline'
import type { Card, Rank, Suit } from './game/card'

const cardImages: Record<Rank, Record<Suit, string>> = {
  '9': { clubs: nineClubs, diamonds: nineDiamonds, hearts: nineHearts, spades: nineSpades },
  '10': { clubs: tenClubs, diamonds: tenDiamonds, hearts: tenHearts, spades: tenSpades },
  J: { clubs: jackClubs, diamonds: jackDiamonds, hearts: jackHearts, spades: jackSpades },
  Q: { clubs: queenClubs, diamonds: queenDiamonds, hearts: queenHearts, spades: queenSpades },
  K: { clubs: kingClubs, diamonds: kingDiamonds, hearts: kingHearts, spades: kingSpades },
  A: { clubs: aceClubs, diamonds: aceDiamonds, hearts: aceHearts, spades: aceSpades },
}

export const playableCardImageUrls = Object.values(cardImages).flatMap((suitImages) => {
  return Object.values(suitImages)
})
export const cardBackImage = blueCardBack
export const scoreFiveImages = { 0: fiveSpades, 1: fiveDiamonds } as const

export function cardImage(card: Card): string {
  return cardImages[card.rank][card.suit]
}

export function cardImageUrls(cards: readonly Card[]): string[] {
  return [...new Set(cards.map(cardImage))]
}
