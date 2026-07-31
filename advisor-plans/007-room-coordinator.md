---
status: not-started
phase: 1
updated: 2026-07-28
---

# Add Room Coordinators

## Goal

Replace per-player room ticks with one Durable Object coordinator while PostgreSQL remains authoritative.

## Context & Decisions

| Decision                                        | Rationale                                                                   | Source                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| Keep PostgreSQL authoritative                   | The first Durable Object version must not add a second game-state authority | `ref:euchre-live-transport-plan@f3f6b90` |
| Store only ephemeral coordination in the object | Rollback and eviction must recover from PostgreSQL                          | `ref:euchre-live-transport-plan@f3f6b90` |
| Keep the public SSE URL                         | The client protocol can migrate without a route change                      | `ref:euchre-live-transport-plan@f3f6b90` |
| Use the shared `src/worker.ts` entry            | Queue handlers and the Durable Object need one Worker module                | `ref:euchre-live-transport-plan@f3f6b90` |

## Phase 1: Caller-Independent Reconciliation [PENDING]

- [ ] **1.1 Add tests for one reconciliation schedule, batched presence, and exact timer actions** ← CURRENT
- [ ] 1.2 Split caller heartbeat from room reconciliation
- [ ] 1.3 Renew all active users in one presence write
- [ ] 1.4 Return the next due bot, trick, heartbeat, or stale deadline
- [ ] 1.5 Keep game version changes limited to game mutations

## Phase 2: Inactive Durable Object [PENDING]

- [ ] 2.1 Export `RoomCoordinator` from the shared Worker entry
- [ ] 2.2 Add the binding and a new SQLite-class migration to `wrangler.jsonc`
- [ ] 2.3 Generate binding types and keep coordinator mode off
- [ ] 2.4 Map room IDs with `idFromName(roomId)`

## Phase 3: Scheduling And Streams [PENDING]

- [ ] 3.1 Track authenticated connections by user and connection ID
- [ ] 3.2 Run one nearest-deadline timer for attached streams
- [ ] 3.3 Persist alarms for autonomous bot and trick deadlines
- [ ] 3.4 Reload deadlines and room state from PostgreSQL after eviction
- [ ] 3.5 Query one private `RoomView` per distinct connected user

## Phase 4: Notifications And Rollout [PENDING]

- [ ] 4.1 Send a best-effort room poke only after a PostgreSQL commit
- [ ] 4.2 Recover from a failed poke through scheduled reconciliation
- [ ] 4.3 Add `off`, `shadow`, and `on` rollout modes
- [ ] 4.4 Canary by a stable room-ID percentage
- [ ] 4.5 Remove per-player ticks only after full rollout

## Completion Criteria

- One room has one coordinator regardless of player count.
- A four-player idle room performs at most one presence transaction each five seconds.
- Bot and trick actions execute once at their existing deadlines.
- PostgreSQL can recover all state after object eviction or rollback.
- No private view is sent to another player.
- Setting mode to `off` restores the old room stream without data migration.

## Notes

- 2026-07-28: Current SSE runs one 500 ms tick for each stream at `src/routes/api/tables/$roomId/events.ts:82-119`. `ref:euchre-live-transport-plan@f3f6b90`
