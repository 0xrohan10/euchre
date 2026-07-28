export type GameRules = {
  stickDealer: boolean
  requireNaturalTrump: boolean
  allowAloneWhenOrderingPartner: boolean
  allowFarmersHand: boolean
}

export const DEFAULT_RULES: GameRules = {
  stickDealer: true,
  requireNaturalTrump: true,
  allowAloneWhenOrderingPartner: false,
  allowFarmersHand: false,
}
