---
status: completed
phase: 1
updated: 2026-07-30
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
| Persist wakeups before dispatch                 | PostgreSQL outbox generations close the commit-to-poke crash window         | Adversarial review, 2026-07-30           |
| Fence schedulers in PostgreSQL                  | Rollout changes cannot leave legacy and coordinator ticks mutating together | Adversarial review, 2026-07-30           |

## Phase 1: Caller-Independent Reconciliation [COMPLETE]

- [x] 1.1 Add tests for one reconciliation schedule, batched presence, and exact timer actions
- [x] 1.2 Split caller heartbeat from room reconciliation
- [x] 1.3 Renew all active users in one presence write
- [x] 1.4 Return the next due bot, trick, heartbeat, or stale deadline
- [x] 1.5 Keep game version changes limited to game mutations

## Phase 2: Inactive Durable Object [COMPLETE]

- [x] 2.1 Export `RoomCoordinator` from the shared Worker entry
- [x] 2.2 Add the binding and a new SQLite-class migration to `wrangler.jsonc`
- [x] 2.3 Generate binding types and keep coordinator mode off
- [x] 2.4 Map room IDs with `getByName(roomId)`

## Phase 3: Scheduling And Streams [COMPLETE]

- [x] 3.1 Track authenticated connections by user and connection ID
- [x] 3.2 Run one nearest-deadline timer for attached streams
- [x] 3.3 Persist alarms for autonomous bot and trick deadlines
- [x] 3.4 Reload deadlines and room state from PostgreSQL after eviction
- [x] 3.5 Query one private `RoomView` per distinct connected user

## Phase 4: Notifications And Rollout [COMPLETE]

- [x] 4.1 Send a best-effort room poke only after a PostgreSQL commit
- [x] 4.2 Recover from a failed poke through scheduled reconciliation
- [x] 4.3 Add `off`, `shadow`, and `on` rollout modes
- [x] 4.4 Canary by a stable room-ID percentage
- [x] 4.5 Bypass per-player ticks only for rooms selected in `on` mode

## Completion Criteria

- One room has one coordinator regardless of player count.
- A four-player idle room performs at most one presence transaction each five seconds.
- Bot and trick actions execute once at their existing deadlines.
- PostgreSQL can recover all state after object eviction or rollback.
- No private view is sent to another player.
- Setting mode to `off` restores the old room stream without data migration.

## Adversarial Hardening [COMPLETE]

- [x] Persist a generation-based `room_wakeup` outbox transactionally through a room mutation trigger
- [x] Dispatch identifier-only messages to `room-coordinator-wakeups`; acknowledge only after alarm installation
- [x] Recover bounded pending wakeups from the scheduled Worker trigger
- [x] Drain coordinator signals through a dirty loop so interleaved poke/alarm/connect signals start a later pass
- [x] Transfer the exact user/scope/page/lease capability through `LIVE_STREAM_ADMISSION` before connect
- [x] Validate UUID and projected seat membership before admission or Durable Object namespace access
- [x] Fence legacy and coordinator mutation paths with `room_scheduler_lease` mode and epoch ownership
- [x] Exercise real Durable Object SQLite storage, alarm, replacement, release, and eviction access under workerd
- [x] Acquire and epoch-validate coordinator ownership inside every PostgreSQL mutation transaction
- [x] Fence a stalled coordinator after expiry and legacy takeover with an owner-specific epoch
- [x] Install a durable retry alarm before exposing dirty-loop failure and close failed initial streams
- [x] Return a transferred admission capability after initial reconciliation failure, or release it before edge reacquisition
- [x] Stop selected modern legacy streams with read-only refresh handover and reject coordinator ownership contention without legacy fallback

## Deployment Barrier

Apply `20260730161725_hard_vulture` before deploying code that can set coordinator mode to `on`. Keep mode `off` for at least one scheduler lease TTL (15 seconds) after all old Workers are drained, then move through `shadow` to `on`; old Workers that predate the lease cannot coexist with `on` mode and must be fully drained before activation.

## Notes

- 2026-07-28: Current SSE runs one 500 ms tick for each stream at `src/routes/api/tables/$roomId/events.ts:82-119`. `ref:euchre-live-transport-plan@f3f6b90`
- 2026-07-30: Implemented migration tag `v2-room-coordinator`; rollout defaults to `off` and legacy SSE remains the rollback path.
- 2026-07-30: PostgreSQL remains authoritative. Durable Object storage contains only the room ID needed to reconstruct alarm scheduling after eviction.
- 2026-07-30: Added durable wakeup queue/outbox recovery, admission capability transfer, dirty reconciliation, UUID/membership admission ordering, scheduler lease/epoch fencing, and workerd integration coverage. Created `room-coordinator-wakeups` and `room-coordinator-wakeups-dlq` in Cloudflare.
- 2026-07-30: Closed the final scheduler race by replacing the separately committed coordinator lease with owner-specific, epoch-validated acquisition inside each presence/tick mutation transaction. The scheduler row is locked before seat/user/room locks and held through commit; a deterministic expiry/handover integration test proves a resumed stale coordinator cannot write.
- 2026-07-30: Hardened dirty reconciliation so every failed pass installs a retry alarm before rejection. Initial coordinator connect now awaits reconciliation and closes/releases its stream on transient failure; workerd loads both Durable Objects and covers interleaved failure plus alarm recovery.
- 2026-07-30: Closed the final admission and rollout handover findings. Failed initial reconciliation returns the exact transferred lease to edge ownership, with release-and-fresh-acquire as the bounded fallback; selected modern streams cannot renew legacy scheduler ownership, ownership contention returns reconnectable retry until expiry, and off/shadow plus protocol-v1 streams retain legacy behavior.
