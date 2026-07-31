import { teamOf, type Player, type Team } from './player'

export function scoreCompletedHand(
  maker: Player,
  lonePlayer: Player | null,
  teamTricks: readonly [number, number],
): { scoringTeam: Team; points: number } {
  const makerTeam = teamOf(maker)
  const made = teamTricks[makerTeam]
  return {
    scoringTeam: made < 3 ? ((1 - makerTeam) as Team) : makerTeam,
    points: made < 3 ? 2 : made === 5 ? (lonePlayer === null ? 2 : 4) : 1,
  }
}
