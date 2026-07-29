---
status: completed
phase: 1
updated: 2026-07-29
---

# Improve Interaction Feedback

## Goal

Make every asynchronous action clear without predicting hidden or server-controlled game results.

## Context & Decisions

| Decision                                          | Rationale                                                                            | Source                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------- |
| Use typed operation state                         | One boolean cannot explain which action is pending                                   | `ref:euchre-head-a81891b-planning-20260728` |
| Do not replay stale intent                        | A legal action in new state can differ from the action the user saw                  | `ref:euchre-head-a81891b-planning-20260728` |
| Keep optimism only for deterministic projections  | Hidden cards and random deals remain server-controlled                               | `ref:euchre-head-a81891b-planning-20260728` |
| Announce state transitions, not heartbeats        | Frequent live-region messages reduce usability                                       | `ref:euchre-head-a81891b-planning-20260728` |
| Bound every interactive request                   | A lost response must not leave controls pending forever                              | Interaction feedback follow-up              |
| Retry only identical game commands                | The command ledger can confirm an ambiguous commit without replaying new intent      | Interaction feedback follow-up              |
| Treat revocation as the sign-out boundary         | Router failure cannot restore an already-revoked private session                     | Interaction feedback follow-up              |
| Identify each room creation operation             | A retry after an abandoned response must resolve to the original room                | Final findings follow-up                    |
| Clear private state when sign-out begins          | An ambiguous or failed revocation cannot make cached authenticated state visible     | Final findings follow-up                    |
| Resolve invite origins only from client events    | Lobby and active-table markup must server-render without browser globals             | Post-final findings follow-up               |
| Observe ambiguous operations to settlement        | A UI deadline does not cancel a room creation, invite join, or sign-out request      | Post-final findings follow-up               |
| Let confirmed success invalidate failure paths    | Reconciliation and deadlines cannot safely overrule an original successful request   | Remaining findings follow-up                |
| Bind mutations to authentication generations      | Late authenticated work must not repopulate state after sign-out                     | Remaining findings follow-up                |
| Pin ambiguous creation payloads                   | Displayed settings must remain identical to the idempotent retry payload             | Remaining findings follow-up                |
| Classify creation outcomes at the server boundary | Only an explicit domain rejection proves that no room committed                      | Final interaction findings                  |
| Settle joins before navigation                    | Router rejection or stalls cannot invalidate confirmed membership or room state      | Final interaction findings                  |
| Acquire active rooms by authenticated user        | Different creation kinds and operation IDs must converge without lock-order races    | Final finding                               |
| Block conflicting ambiguous creation actions      | Recovery must not launch another room while the original request can still commit    | Final finding                               |
| Lock every activating participant before rooms    | Sorted user-first locks serialize joins, party starts, and rematches without cycles  | One-active-room findings                    |
| Use non-key-changing coordinator locks            | `FOR NO KEY UPDATE` preserves serialization without blocking ownership FK key shares | Final five findings                         |
| Enforce active membership in PostgreSQL           | Triggers protect both old and new Workers throughout a rolling deployment            | Final five findings                         |
| Preserve deployed request and response shapes     | Server changes must remain usable by already-loaded clients                          | Final five findings                         |
| Observe authentication through settlement         | A UI deadline cannot classify later confirmed authentication as failure              | Final five findings                         |
| Negotiate typed stale command responses           | Only clients that explicitly send response version 2 may receive the stale wrapper   | Final three interaction findings            |
| Read active rooms from authoritative membership   | Historical timestamps cannot outrank the one-active-room projection                  | Final three interaction findings            |
| Serialize credential attempts through settlement  | A deadline cannot permit overlapping attempts with contradictory late outcomes       | Final three interaction findings            |

## Phase 1: Action State [COMPLETE]

- [x] 1.1 Replace global pending booleans with typed operation state and labels
- [x] 1.2 Disable only controls that conflict with the active operation
- [x] 1.3 Route bot votes through the same pending and error path
- [x] 1.4 Add one polite status region and local `aria-busy` states

## Phase 2: Stale Commands [COMPLETE]

- [x] 2.1 Replace message regexes with a stable stale command result
- [x] 2.2 Apply the new projected room and clear optimistic state
- [x] 2.3 Ask the player to review and try again; do not replay automatically
- [x] 2.4 Keep transport retries idempotent with the same command ID

## Phase 3: Trust Feedback [COMPLETE]

- [x] 3.1 Show clipboard success and a manual-copy fallback on failure
- [x] 3.2 Use `try/catch/finally` for sign-in, sign-up, sign-out, and vote operations
- [x] 3.3 Use safe error messages and route invalidation instead of document reloads

## Phase 4: Connection And Accessibility [COMPLETE]

- [x] 4.1 Display live, reconnecting, and stale states from the live-event manager
- [x] 4.2 Disable actions when the current room snapshot is not trustworthy
- [x] 4.3 Add focus entry, containment, Escape rules, and restoration to blocking dialogs
- [x] 4.4 Associate errors with controls and respect reduced motion

## Phase 5: Findings Follow-Up [COMPLETE]

- [x] 5.1 Portal blocking dialogs above the full viewport and block outside pointer/focus interaction
- [x] 5.2 Close competing header/native dialogs and safely restore a still-valid focus target
- [x] 5.3 Add a reusable request deadline to lobby, invite, auth, vote, rematch, and leave operations
- [x] 5.4 Retry a timed-out game command once with the original command ID and expected version
- [x] 5.5 Report a twice-timed-out command as an unknown outcome and defer reconciliation to live/current room state
- [x] 5.6 Clear authenticated room, party, invite, and transport state before fallible routing
- [x] 5.7 Fall back to the sign-in location after post-revocation routing failure or timeout

## Phase 6: Final Findings [COMPLETE]

- [x] 6.1 Render a hydration-compatible blocking-dialog placeholder before mounting its client portal
- [x] 6.2 Preserve focus entry, containment, and restoration after the portal mounts
- [x] 6.3 Reuse a client-generated room-creation operation ID across one bounded retry
- [x] 6.4 Persist `(user_id, operation_id) -> room_id` and serialize concurrent duplicate creation
- [x] 6.5 Keep multiplayer and single-player operation identities distinct
- [x] 6.6 Clear room, party, invite, transport, and private UI state synchronously when sign-out begins
- [x] 6.7 Keep state cleared after failed or timed-out revocation and route safely after late success

## Phase 7: Post-Final Findings [COMPLETE]

- [x] 7.1 Build room and party invite URLs in the copy event handler and hydrate lobby/table markup without browser-global render access
- [x] 7.2 Retain one room-creation operation ID per creation kind across automatic deadlines and later manual retries
- [x] 7.3 Observe every timed-out creation attempt and apply the first eventual room exactly once
- [x] 7.4 Own sign-out pending, failure, retry, private-state teardown, and late settlement in `AuthenticatedAppProvider`
- [x] 7.5 Keep provider children hidden throughout local sign-out retries and navigate to sign-in only after confirmed revocation
- [x] 7.6 Observe room and party invite joins after the UI deadline and reconcile current room and party before reporting failure

## Phase 8: Remaining Findings [COMPLETE]

- [x] 8.1 Reconcile invite joins through one generation and settlement state machine so original success invalidates failure and home navigation
- [x] 8.2 Invalidate authenticated mutation callbacks on sign-out and gate room and lobby transports on the authenticated shell state
- [x] 8.3 Move timed-out sign-out into an explicit ambiguous retry state while continuing to observe every revocation attempt
- [x] 8.4 Pin ambiguous room creation rules to the immutable retained request and unlock them only after definitive rejection

## Phase 9: Final Interaction Findings [COMPLETE]

- [x] 9.1 Return explicit created or definitive-rejection outcomes from room creation server functions
- [x] 9.2 Retain ambiguous creation operation IDs and reconcile them through the durable creation ledger
- [x] 9.3 Cover commit-then-response-loss and same-identity retry with database and UI tests
- [x] 9.4 Apply confirmed room state before bounded navigation and use router history as the safe game-route fallback
- [x] 9.5 Release failed invite execution keys while preserving successful join settlement across navigation failure
- [x] 9.6 Cover rejected and never-settling post-join navigation without failure feedback or lost room state

## Phase 10: Active Room Acquisition [COMPLETE]

- [x] 10.1 Lock the authenticated user row first in multiplayer and single-player creation transactions
- [x] 10.2 Map every new creation operation to an existing lobby, playing, or paused room seat before creating a room
- [x] 10.3 Allow multiple operation ledger entries to resolve to one room while preserving same-operation kind checks and replay
- [x] 10.4 Cover concurrent same-kind and mixed-kind creation with different operation IDs in database integration tests
- [x] 10.5 Lock Back, table joins, partnership creation/start, and alternate creation paths during ambiguous recovery
- [x] 10.6 Explain recovery clearly, keep identical retry available, and apply late original success

## Phase 11: One Active Room [COMPLETE]

- [x] 11.1 Add shared sorted user-row locking and target-aware active-room conflict helpers
- [x] 11.2 Apply user-first locking to room joins, both creation kinds, and party room starts
- [x] 11.3 Pre-read rematch participants, lock users in deterministic order, then lock and revalidate the room
- [x] 11.4 Protect command rematches, party rematches, and finished-room presence transitions without room-to-user lock cycles
- [x] 11.5 Preserve creation/command/vote idempotency and allow the same target room during active-room checks
- [x] 11.6 Cover both race orders for create/join, party start versus join/create for either partner, rematch/create, overlapping rematches, and the finished target exception

## Phase 12: Final Five Findings [COMPLETE]

- [x] 12.1 Change sorted user coordinator locks to `FOR NO KEY UPDATE` and cover party/room ownership FK coexistence
- [x] 12.2 Reuse a party room only when its current human users exactly equal current party membership, including bot replacement
- [x] 12.3 Add generated `active_room_membership` schema and a hardened migration with duplicate precondition, backfill, and old-Writer seat/status triggers
- [x] 12.4 Accept legacy creation payloads and preserve legacy successful command response shapes while new clients normalize stale and applied results
- [x] 12.5 Observe sign-in and sign-up through late settlement, separate auth rejection from routing failure, and hard-fallback after bounded navigation

## Phase 13: Final Three Interaction Findings [COMPLETE]

- [x] 13.1 Add command response version 2 and preserve unversioned stale rejection plus successful `RoomView` responses
- [x] 13.2 Select current rooms from `active_room_membership` before considering the latest finished historical room
- [x] 13.3 Keep timed-out credential attempts disabled until definitive settlement and cover both late success and rejection orderings

## Completion Criteria

- Every mutation has immediate and specific feedback.
- Stale commands never replay against unseen state.
- Clipboard and authentication failures always leave a usable retry path.
- Users can distinguish live, reconnecting, and stale room data.
- Blocking dialogs manage keyboard focus.
- No interactive request can remain pending indefinitely.
- A game-command transport retry never changes command identity or expected version.
- Successful sign-out revocation cannot be reported as failed because routing failed.
- Initially open blocking dialogs server-render and hydrate without accessing `document` during render.
- Retried or concurrent duplicate room creation returns the same projected room.
- Sign-out timeout or failure cannot restore cached private state.
- Lobby and active-table server markup hydrates without reading `window.location` during render.
- Manual room-creation retries reuse the original operation ID until a room is confirmed.
- Timed-out invite joins and sign-out revocations remain observable and apply late success.
- Original invite success cannot race a null reconciliation into failure or home navigation.
- Late invite and room-creation results cannot repopulate state or restart transports after sign-out.
- A never-settling sign-out response exits pending for an explicit safe retry state.
- Ambiguous room-creation retries display and send the same immutable rules payload.
- Ambiguous promise rejection cannot clear a room-creation operation ID; only a confirmed room or explicit non-committing domain rejection can.
- Confirmed room joins apply state before navigation, and navigation rejection or timeout falls back to the game route without reporting join failure.
- Failed invite executions release their navigation key so the same invite can recover.
- Concurrent creation requests for one user converge on one active room across kinds and operation IDs.
- Ambiguous creation exposes only the identical retry until rejection or confirmed room recovery.
- No human can be activated in a lobby, playing, or paused room while seated in another active room.
- Every activating transaction locks all affected user rows in sorted order before locking or mutating room state.
- Coordinator locks remain compatible with party and room ownership foreign-key checks.
- PostgreSQL rejects duplicate active-room membership from old and new Workers during rollout.
- Migration aborts with an actionable precondition instead of discarding duplicate active games.
- Already-loaded clients can create rooms and consume successful command responses from the new server.
- Confirmed authentication success cannot later render authentication failure, even after a deadline or router failure.
- Typed stale command wrappers are returned only to clients that explicitly request response version 2.
- Current room and bootstrap selection always prefer authoritative active membership over historical timestamps.
- A timed-out credential request cannot overlap another sign-in or sign-up attempt while it remains unsettled.

## Notes

- 2026-07-28: Current stale handling parses messages and replays actions in `src/components/GameTable.tsx:182-229`. `ref:euchre-head-a81891b-planning-20260728`
- 2026-07-29: Implemented typed command and operation feedback, room snapshot trust states, resilient clipboard/auth/vote paths, accessible blocking dialogs, and focused interaction tests.
- 2026-07-29: Closed three follow-up findings with viewport-level modal isolation and user-event coverage, bounded requests and same-command retry/unknown-outcome handling, and provider-owned post-revocation cleanup with safe routing fallback. Verified the full test, typecheck, lint, format, and production build gates.
- 2026-07-29: Closed the final three findings with client-mounted dialog portals and SSR hydration coverage, durable room-creation idempotency via generated migration `20260729060236_luxuriant_magus`, and eager one-way sign-out teardown with late-settlement handling. Applied the full migration chain to a fresh database and passed the database integration suite.
- 2026-07-29: Closed four post-final findings with event-time invite URL construction and lobby/table hydration tests, creation-kind operation retention across two deadlines and manual retry, provider-owned durable sign-out failure/retry UI, and late invite settlement plus current-room/current-party reconciliation.
- 2026-07-29: Closed the four remaining findings with generation-owned invite settlement, authentication-generation mutation guards and transport gating, an explicit ambiguous sign-out retry shell that observes original revocation, and immutable displayed rules for ambiguous room creation retries.
- 2026-07-29: Closed the final two interaction findings with explicit creation outcomes plus durable operation lookup, join-first room application plus bounded history fallback, and recoverable failed invite keys. Verified `RUN_DB_INTEGRATION=1 bun run test` (25 files, 263 tests), `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run build`.
- 2026-07-29: Closed the active-room acquisition finding with a shared user-first lock order, active-seat reuse across creation kinds and operation IDs, multi-entry operation ledger mapping via generated migration `20260729071721_sad_mandrill`, ambiguous-creation action locking, and late-success UI coverage. Verified `RUN_DB_INTEGRATION=1 bun run test` (25 files, 267 tests), `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run build`.
- 2026-07-29: Closed both one-active-room findings with shared deterministic participant locks and target-aware conflict checks across creation, joins, party starts, command/party rematches, and finished-room presence repair. Added lock-barrier races in both winner orders, including either party member and overlapping rematch participants. Verified `RUN_DB_INTEGRATION=1 bun run test` (25 files, 282 tests), `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run build`.
- 2026-07-29: Closed the final five findings with non-key-changing user locks, exact party-room human membership, generated active-membership schema plus hardened rollout triggers, deployed-client protocol compatibility, and late-settling authentication reconciliation. Applied the full migration chain to fresh disposable databases and separately verified the duplicate-data migration precondition reports affected users without deleting games. Verified `RUN_DB_INTEGRATION=1 bun run test` (27 files, 293 tests), `bun run typecheck`, `bun run lint`, `bun run fmt`, and `bun run build`.
- 2026-07-29: Closed the final three interaction findings with opt-in command response version 2, authoritative membership-first current-room selection with finished-history fallback, and serialized credential attempts that remain disabled through late settlement. Applied the generated migration chain to the local integration database. Verified `RUN_DB_INTEGRATION=1 bun run test` (28 files, 303 tests), `bun run typecheck`, `bun run lint`, `bun run fmt`, `bun run fmt:check`, and `bun run build`.
