export type Player = 0 | 1 | 2 | 3

export function next(player: Player): Player {
  return ((player + 1) % 4) as Player
}

export function teamOf(player: Player): 0 | 1 {
  return (player % 2) as 0 | 1
}

export function nextActive(player: Player, lonePlayer: Player | null): Player {
  const candidate = next(player)
  if (lonePlayer !== null && candidate === (lonePlayer + 2) % 4) {
    return next(candidate)
  }
  return candidate
}
