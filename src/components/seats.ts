import type { SeatView } from '../multiplayer'

export const SEAT_ORDER = [0, 1, 2, 3] as const

export function seatsByNumber(seats: SeatView[]): Map<number, SeatView> {
  const bySeat = new Map<number, SeatView>()
  for (const seat of seats) {
    bySeat.set(seat.seat, seat)
  }
  return bySeat
}
