export type Player = 0 | 1 | 2 | 3
export type Team = 0 | 1

export function next(player: Player): Player {
  return ((player + 1) % 4) as Player
}

export function teamOf(player: Player): Team {
  return (player % 2) as Team
}

export function teamName(team: Team): 'Black' | 'Red' {
  return team === 0 ? 'Black' : 'Red'
}

export function nextActive(player: Player, lonePlayer: Player | null): Player {
  const candidate = next(player)
  if (lonePlayer !== null && candidate === (lonePlayer + 2) % 4) {
    return next(candidate)
  }
  return candidate
}
