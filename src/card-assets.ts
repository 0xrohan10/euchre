import aceClubs from 'cardsJS/cards/AC.svg'
import aceDiamonds from 'cardsJS/cards/AD.svg'
import aceHearts from 'cardsJS/cards/AH.svg'
import aceSpades from 'cardsJS/cards/AS.svg'
import blueCardBack from 'cardsJS/cards/Blue_Back.svg'
import fiveDiamonds from 'cardsJS/cards/5D.svg'
import fiveSpades from 'cardsJS/cards/5S.svg'
import jackClubs from 'cardsJS/cards/JC.svg'
import jackDiamonds from 'cardsJS/cards/JD.svg'
import jackHearts from 'cardsJS/cards/JH.svg'
import jackSpades from 'cardsJS/cards/JS.svg'
import kingClubs from 'cardsJS/cards/KC.svg'
import kingDiamonds from 'cardsJS/cards/KD.svg'
import kingHearts from 'cardsJS/cards/KH.svg'
import kingSpades from 'cardsJS/cards/KS.svg'
import queenClubs from 'cardsJS/cards/QC.svg'
import queenDiamonds from 'cardsJS/cards/QD.svg'
import queenHearts from 'cardsJS/cards/QH.svg'
import queenSpades from 'cardsJS/cards/QS.svg'
import tenClubs from 'cardsJS/cards/10C.svg'
import tenDiamonds from 'cardsJS/cards/10D.svg'
import tenHearts from 'cardsJS/cards/10H.svg'
import tenSpades from 'cardsJS/cards/10S.svg'
import nineClubs from 'cardsJS/cards/9C.svg'
import nineDiamonds from 'cardsJS/cards/9D.svg'
import nineHearts from 'cardsJS/cards/9H.svg'
import nineSpades from 'cardsJS/cards/9S.svg'
import type { Card, Rank, Suit } from './game'

const cardImages: Record<Rank, Record<Suit, string>> = {
  '9': { clubs: nineClubs, diamonds: nineDiamonds, hearts: nineHearts, spades: nineSpades },
  '10': { clubs: tenClubs, diamonds: tenDiamonds, hearts: tenHearts, spades: tenSpades },
  J: { clubs: jackClubs, diamonds: jackDiamonds, hearts: jackHearts, spades: jackSpades },
  Q: { clubs: queenClubs, diamonds: queenDiamonds, hearts: queenHearts, spades: queenSpades },
  K: { clubs: kingClubs, diamonds: kingDiamonds, hearts: kingHearts, spades: kingSpades },
  A: { clubs: aceClubs, diamonds: aceDiamonds, hearts: aceHearts, spades: aceSpades },
}

export const cardBackImage = blueCardBack
export const scoreFiveImages = { 0: fiveSpades, 1: fiveDiamonds } as const

export function cardImage(card: Card): string {
  return cardImages[card.rank][card.suit]
}
