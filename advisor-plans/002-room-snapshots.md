---
status: complete
phase: 4
updated: 2026-07-28
---

# Consolidate Room Snapshots

## Goal

Use bounded room snapshot queries and reuse known state after mutations while preserving lock ordering and private data.

## Context & Decisions

| Decision                                      | Rationale                                                                 | Source                                            |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Keep redaction in application code            | SQL rows contain private game state                                       | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |
| Lock only the room row                        | Child rows are read after acquiring the room serialization lock           | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |
| Keep idle ticks repeatable-read and lock-free | The current preflight avoids unnecessary contention                       | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |
| Bound each child aggregation                  | Independent capped JSON arrays avoid Cartesian row and `room.game` growth | Adversarial review, 2026-07-28                    |
| Use two SELECTs for mutations                 | A joined locking SELECT can evaluate child rows before its room lock wait | Adversarial review, 2026-07-28                    |
| Complete rating separation first              | It removes unrelated queries and reduces merge conflicts                  | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |

## Phase 1: Characterization [COMPLETE]

- [x] 1.1 Add SQL-count tests for room reads, idle ticks, commands, votes, rematches, and presence
- [x] 1.2 Add service-level tests for hidden fields and viewer hand projection
- [x] 1.3 Preserve duplicate-command ordering before stale-version checks

## Phase 2: Snapshot Module [COMPLETE]

- [x] 2.1 Add `src/server/room-view.server.ts`
- [x] 2.2 Aggregate seats, ratings, votes, rematch votes, and an optional command in correlated JSON subqueries
- [x] 2.3 Cap child arrays at domain bounds: 4 seats, 8 ratings, 12 disconnect votes, 4 rematch votes, and 1 command
- [x] 2.4 Use `FOR UPDATE OF room` only for mutation snapshots
- [x] 2.5 Convert snapshots to `RoomView` only through `projectGame`

## Phase 3: Read Paths [COMPLETE]

- [x] 3.1 Replace `viewRoom` fan-out with the snapshot loader
- [x] 3.2 Make `getRoom` and stable idle tick use one SELECT
- [x] 3.3 Load latest current-room and waiting-room snapshots without truncating seats

## Phase 4: Mutation Paths [COMPLETE]

- [x] 4.1 Acquire `FOR UPDATE OF room` before reading child state in submit, vote, rematch, presence, and mutating tick operations
- [x] 4.2 Build the response from known writes instead of re-reading the room
- [x] 4.3 Batch stale-seat updates during mutating ticks
- [x] 4.4 Keep presence-only changes from incrementing the game version
- [x] 4.5 Add lock-barrier tests for duplicate retries, final bot votes, final rematches, and heartbeat-before-stale evaluation

## Completion Criteria

- `getRoom` and a stable idle tick use one SELECT.
- A normal command uses one room-lock SELECT, one bounded child SELECT, one command insert, and one room update.
- Duplicate command retries use one room-lock SELECT and one bounded child SELECT.
- Mutation child state is acquired after the room row lock; mutation responses do not reload after writes.
- Read snapshots return one outer room row with bounded child arrays and transfer `room.game` once.
- No returned payload contains hidden game fields.
- Existing lock, race, CAS, and idempotency tests pass.

## Notes

- 2026-07-28: Current room projection uses separate room, seat, vote, rematch, and rating queries at `src/server/game-service.server.ts:452-603`. `ref:euchre-hyperdrive-planning-f3f6b90-20260728`
- 2026-07-28: Correctness review replaced joined mutation snapshots with a room lock followed by a child aggregation SELECT. Read paths remain one SELECT; mutation paths intentionally use two SELECTs.
