---
status: completed
phase: 1
updated: 2026-07-29
---

# Add Live Lobby Events

## Goal

Replace lobby polling and make room streams recover safely from idle connections and temporary failures.

## Context & Decisions

| Decision                                               | Rationale                                                | Source                                   |
| ------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------- |
| Send full projected snapshots                          | Reconnects do not need delta replay                      | `ref:euchre-live-transport-plan@f3f6b90` |
| Keep transport heartbeats separate from database reads | An idle game must still prove connection health          | `ref:euchre-live-transport-plan@f3f6b90` |
| Keep healthy hidden streams open                       | A hidden seated player must not appear disconnected      | `ref:euchre-live-transport-plan@f3f6b90` |
| Authenticate before the SSE body                       | Unauthorized requests must return a normal HTTP response | `ref:euchre-live-transport-plan@f3f6b90` |
| Cap three streams per user and scope in each isolate   | Cloned tabs work without allowing an unbounded SSE flood | Adversarial review, 2026-07-28           |
| Lease three streams per user and scope globally        | A Durable Object closes the cross-isolate admission gap  | Live-event follow-up, 2026-07-28         |
| Keep admission separate from room coordination         | The gate owns stream leases only; plan 007 owns gameplay | Live-event follow-up, 2026-07-28         |

## Phase 1: Protocol And Lifecycle [COMPLETE]

- [x] 1.1 Define versioned ready, snapshot, heartbeat, degraded, and terminal events
- [x] 1.2 Extract server framing, timer, backoff, lifetime, and cleanup logic
- [x] 1.3 Add fake-timer tests for backoff, heartbeat, terminal errors, and cleanup

## Phase 2: Harden Room SSE [COMPLETE]

- [x] 2.1 Replace the fixed 500 ms failure retry with exponential backoff and jitter
- [x] 2.2 Emit a 15-second heartbeat without room data
- [x] 2.3 Cap each stream lifetime and require reauthentication on reconnect
- [x] 2.4 Keep each viewer projection separate and private

## Phase 3: Lobby SSE [COMPLETE]

- [x] 3.1 Add an authenticated `/api/lobby/events` endpoint
- [x] 3.2 Derive user identity from the session only
- [x] 3.3 Send changed `{ party, room }` snapshots and close after room assignment
- [x] 3.4 Keep the old polling server function during rollout

## Phase 4: Client Transport [COMPLETE]

- [x] 4.1 Add one testable EventSource manager for lobby and room scopes
- [x] 4.2 Add reconnect jitter, online recovery, visibility rules, and a heartbeat watchdog
- [x] 4.3 Reject stale callbacks from stopped connection generations
- [x] 4.4 Prefer lobby events and fall back to polling when EventSource is unsupported or fails
- [ ] 4.5 Remove the old polling module after a later stable release

## Phase 5: Adversarial Hardening [COMPLETE]

- [x] 5.1 Ignore client connection IDs for admission; assign server IDs and replace the oldest of three isolate-local streams
- [x] 5.2 Terminate replaced streams without reconnect so excess cloned tabs settle instead of evicting forever
- [x] 5.3 Invalidate lobby callbacks synchronously on local join, leave, and room-open transitions
- [x] 5.4 Bound snapshot loads to 10 seconds and require room snapshot progress within 12 seconds
- [x] 5.5 Reset client reconnect backoff only after a valid snapshot
- [x] 5.6 Generate one in-memory client connection identity per page instead of using `sessionStorage`
- [x] 5.7 Restore `getWaitingLobbyFn` and the polling module for mixed-version deployment and rollback

## Phase 6: Live-Event Findings [COMPLETE]

- [x] 6.1 Dual-emit legacy `room`/`gone` events and accept them in the protocol-v1 client without applying a snapshot twice
- [x] 6.2 Scope transport success to each generation and fall back after three failed post-success generations
- [x] 6.3 Preserve the lobby epoch for same-party updates so a room assignment reaches the mounted transport
- [x] 6.4 Add eight-second PostgreSQL statement/query timeouts and prevent a timed-out load from spawning overlapping work
- [x] 6.5 Validate the in-memory page UUID and replace only that page's stale isolate generation
- [x] 6.6 Add a user-keyed Durable Object with three leases per scope, 45-second TTL cleanup, same-page replacement, heartbeat renewal, and cleanup release
- [x] 6.7 Add the `LIVE_STREAM_ADMISSION` binding, SQLite Durable Object migration `v1`, generated Worker types, and Worker export

## Phase 7: Final Lease Hardening [COMPLETE]

- [x] 7.1 Keep every admitted same-page generation counted until explicit release or TTL expiry; deny acquisition before mutating existing leases when all three slots are occupied
- [x] 7.2 Mark superseded leases as replaced and return a confirmed `409 replaced` renewal result without hiding them from the admission count
- [x] 7.3 Treat only `404 expired` and `409 replaced` as confirmed lease loss; throw transient and malformed renewal responses into degraded retry
- [x] 7.4 Cover a high-concurrency same-page flood through shared Durable Object storage, cleanup recovery, temporary renewal outage recovery, and confirmed expiry

## Phase 8: Remaining Live-Event Findings [COMPLETE]

- [x] 8.1 Record authoritative snapshot health before payload deduplication, including legacy room snapshots, without redundant React updates
- [x] 8.2 Bound admission renewal retry to 40 seconds, reconnect after expiry for a new lease, and permanently block only replaced streams
- [x] 8.3 Register asynchronous runtime disposal and admission release with the Cloudflare Worker lifetime on every stream termination path
- [x] 8.4 Keep timed-out snapshot loads in flight until the underlying promise settles, with degraded and heartbeat frames but no overlapping load

## Phase 9: Final Live-Event Findings [COMPLETE]

- [x] 9.1 Close cancelled streams immediately but retain admission until in-flight snapshot work settles; anchor deferred release with `waitUntil` and retain TTL expiry as fallback
- [x] 9.2 Refresh lobby snapshots every two seconds, replace hidden lobby SSE with 15-second polling, and reopen SSE without duplicate polling when visibility returns

## Phase 10: Production Lifecycle Findings [COMPLETE]

- [x] 10.1 Track the original non-interrupted `ManagedRuntime.runPromise`; after synchronous stream closure, wait for snapshot settlement before runtime disposal and admission release
- [x] 10.2 Keep timed-out snapshot work pending without scheduling overlapping successors, while continuing degraded and heartbeat transport frames
- [x] 10.3 Distinguish planned max-lifetime `refresh` from admission expiry and reconnect it immediately even while hidden
- [x] 10.4 Require a successful 2xx release response and retry the idempotent release with bounded backoff inside `waitUntil`, leaving lease TTL as the final fallback

## Phase 11: Final Admission And Refresh Findings [COMPLETE]

- [x] 11.1 Abort every admission acquire, renew, and release fetch after two seconds so transport hangs remain retryable and cannot consume the surrounding retry window
- [x] 11.2 Preserve urgent planned-refresh state across failed replacement generations, cap hidden retries at three seconds until an authoritative snapshot, and retain counted lease overlap instead of introducing a flood-prone handoff
- [x] 11.3 Cover never-settling acquire and renew fetches, every release retry through success and exhaustion, pending-load lifetime cleanup, denied hidden replacement acquisition, eventual reconnect, and urgent-state reset after snapshot

## Phase 12: Confirmed-Release Rollover [COMPLETE]

- [x] 12.1 Mark max-lifetime refresh requested without stopping serialized room ticks, snapshots, heartbeats, or lease renewal
- [x] 12.2 Wait for underlying database work to settle before each release cycle and retry idempotent release after transient failures
- [x] 12.3 Keep every release request under a two-second deadline and require a 2xx response before treating the slot as free
- [x] 12.4 Stop presence work, emit refresh, and close only after confirmed release; retain terminal-frame-loss recovery through normal EventSource reconnect
- [x] 12.5 Preserve one-release legacy `stream` rollover without sending a protocol-v1 terminal

## Phase 13: Fresh-Lease Acquisition [COMPLETE]

- [x] 13.1 Give every authenticated stream request a fresh server-generated lease bound to its validated page ID
- [x] 13.2 Remove handoff tokens, acquisition operation IDs, committed-operation storage, and replay paths from the protocol and Durable Object
- [x] 13.3 Keep ambiguous or lost acquire responses counted until request cleanup releases the proposed lease or its TTL expires
- [x] 13.4 Cap hidden room reconnect delay at five seconds while retaining hidden lobby polling and long-delay behavior
- [x] 13.5 Cover prolonged release outage presence, terminal-frame loss, acquire-response loss, operation replay non-bypass, hidden room reconnect, flood bounds, and mixed legacy compatibility

## Phase 14: Refresh Drain Exclusion [COMPLETE]

- [x] 14.1 Enter refresh-draining state synchronously, cancel the scheduled poll, and reject scheduling, due callbacks, and direct publish entry while release is pending
- [x] 14.2 Wait for existing underlying snapshot work before release and prevent any post-release-success poll before stream close
- [x] 14.3 Clear draining after failed or timed-out release, resume a presence-renewing poll before the release retry, and serialize the retry behind that poll
- [x] 14.4 Cover a poll becoming due during release await and failed-release poll resumption with deterministic fake timers

## Phase 15: Bounded Planned Release [COMPLETE]

- [x] 15.1 Give planned rollover a distinct one-attempt release operation bounded by the shared two-second admission deadline
- [x] 15.2 Retain four idempotent release attempts only for final cancellation cleanup, where stream watchdog and presence timing no longer apply
- [x] 15.3 After each planned-release failure, leave draining immediately, allow a serialized presence-renewing room poll, and retry with backoff
- [x] 15.4 Use fake time and repeated two-second release timeouts to keep each attempt below the 12-second snapshot watchdog budget and room ticks below 15-second presence expiry

## Completion Criteria

- The browser sends no repeated lobby polling requests while lobby SSE is supported and healthy.
- An idle stream sends a heartbeat at least every 15 seconds.
- Room snapshot progress cannot be hidden indefinitely by transport heartbeats.
- Failed hidden lobby streams retry no more than once each 30 seconds; hidden room retries are capped at five seconds.
- Stopped streams cannot update current React state.
- Room payloads remain seat-redacted.
- Each Worker isolate admits at most three streams per authenticated user and scope.
- All Worker isolates share at most three admitted live or superseded leases per authenticated user and scope until release or TTL expiry.
- Cancelled streams with unresolved database work continue consuming their admission slot until that work settles or the lease TTL expires.
- Planned max-lifetime refreshes free their lease before reconnecting, including while hidden.
- Admission release accepts only 2xx responses; planned rollover makes one bounded attempt per drain, while final cleanup exhausts four idempotent retries before relying on lease TTL expiry.
- Every admission fetch has a two-second abort deadline and clears its timer after settlement.
- Planned refresh waits for settled database work before each single release attempt, keeps room presence active through release outages, and emits refresh only after a confirmed 2xx release.
- Planned refresh drains poll scheduling before awaiting release; failed release resumes presence polling before retry, while successful release permits no later poll before close.
- Losing the refresh terminal frame cannot retain or replay admission state; normal EventSource close and reconnect uses the already-free slot.
- Every acquire uses a fresh server lease and cannot replay an earlier operation to bypass the three-stream cap.
- Lost acquire responses remain counted until request cleanup confirms release or lease TTL expiry removes them.
- Legacy `stream` query clients receive no protocol-v1 max-lifetime terminal and reconnect only after ordinary admission release.
- Lobby pages use SSE only while visible and 15-second polling only while hidden; room SSE remains open for hidden presence.

## Notes

- 2026-07-28: Current lobby polling uses 2-second and 15-second intervals in `src/waiting-lobby-polling.ts:21-29`. `ref:euchre-live-transport-plan@f3f6b90`
- 2026-07-28: Added protocol v1 and shared server/client stream lifecycles.
- 2026-07-28: Adversarial follow-up retained the authenticated polling rollback path, added isolate-local admission and non-reconnecting replacement, and separated transport health from room snapshot progress.
- 2026-07-28: Added one-release mixed-version event compatibility and a dedicated global stream-admission Durable Object. Plan 007 remains a separate room coordinator and does not own stream admission.
- 2026-07-28: Verified `bun run test` (146 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt:check`, `bun run build`, and `wrangler deploy --dry-run` with the Durable Object binding present.
- 2026-07-28: Verified `bun run test` (131 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt:check`, and `bun run build`. The production asset verifier reported 27 cards, 10 fonts, and 6 license/provenance files.
- 2026-07-28: Final lease hardening retained superseded same-page generations in the global count and separated confirmed lease loss from retryable Durable Object outages.
- 2026-07-28: Verified final hardening with `bun run test` (151 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run build`, and `bun x wrangler deploy --dry-run`. The dry-run included the `LIVE_STREAM_ADMISSION` Durable Object binding.
- 2026-07-28: Closed the remaining live-event findings by separating authoritative progress from React payload changes, bounding renewal retry below lease TTL, anchoring cleanup to Worker lifetime, and waiting for underlying snapshot settlement after transport timeout.
- 2026-07-28: Verified the remaining findings with `bun run test` (160 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-28: Closed the final findings by coupling lease release to underlying snapshot settlement and making lobby transport visibility-owned: visible pages use SSE, hidden pages use the restored 15-second polling cadence, and room SSE remains independent for presence.
- 2026-07-28: Verified the final findings with `bun run test` (165 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Closed the final production lifecycle findings by preserving the actual `ManagedRuntime.runPromise` through cleanup, ordering runtime disposal before lease release only after settlement, adding immediate hidden lifetime refresh, and validating/retrying release responses before TTL fallback.
- 2026-07-29: Verified production lifecycle hardening with `bun run test` (169 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Closed the final admission and refresh findings with a shared two-second abort boundary around every Durable Object fetch and a snapshot-scoped urgent refresh state that keeps hidden retries at three seconds without weakening counted admission overlap.
- 2026-07-29: Verified final admission and refresh hardening with `bun run test` (174 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Replaced counted planned-refresh overlap with a user-scoped, one-use atomic Durable Object handoff that waits for database settlement, retries preparation while the old stream remains live, and preserves ordinary cancellation, release, and flood behavior.
- 2026-07-29: Verified atomic planned-refresh handoff with `bun run test` (179 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Closed the final live-event findings by continuing serialized room ticks through prolonged handoff-admission outages, journaling operation-bound committed acquisitions for lost-response convergence, retaining handoff intent until a valid snapshot, and giving legacy `stream` clients release-before-close rollover without a protocol-v1 terminal.
- 2026-07-29: Verified lost-response and legacy rollover hardening with `bun run test` (185 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run included `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Removed atomic handoff and committed-operation replay state in favor of fresh per-request leases and confirmed release-before-refresh rollover. Room ticks, snapshots, heartbeats, and renewal continue through release outages; hidden room reconnects are capped at five seconds.
- 2026-07-29: Verified the simplified lifecycle with `bun run test` (183 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run retained `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Closed the final refresh-release race with an explicit draining state that blocks due poll callbacks while release awaits, resumes presence polling after failure before retry, and keeps successful release poll-free through close.
- 2026-07-29: Verified refresh drain exclusion with `bun run test` (185 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run retained `LIVE_STREAM_ADMISSION`.
- 2026-07-29: Split planned release from final cleanup so each rollover drain performs exactly one two-second-bounded attempt, while cancellation cleanup retains four retries. Repeated timeout coverage verifies authoritative snapshots stay below the 12-second watchdog and room ticks below 15-second presence expiry.
- 2026-07-29: Verified bounded planned release with `bun run test` (186 passed, 35 skipped), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, `bun run build`, and `bun x wrangler deploy --dry-run`. Production assets remained at 27 cards, 10 fonts, and 6 license/provenance files; the dry-run retained `LIVE_STREAM_ADMISSION`.
