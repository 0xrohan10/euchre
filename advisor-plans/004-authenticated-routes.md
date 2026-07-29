---
status: complete
phase: 6
updated: 2026-07-28
---

# Load Authenticated Routes

## Goal

Load session and initial application data before rendering and keep multiplayer state during client navigation.

## Context & Decisions

| Decision                                   | Rationale                                                                                                              | Source                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Use a pathless authenticated route         | Existing public URLs stay unchanged                                                                                    | `ref:euchre-head-a81891b-planning-20260728` |
| Keep one persistent multiplayer provider   | Child route changes must not destroy room state or SSE                                                                 | `ref:euchre-head-a81891b-planning-20260728` |
| Do not preload invite mutations            | Link preloading must not join a room or party                                                                          | `ref:euchre-head-a81891b-planning-20260728` |
| Return only projected room data            | Route data must not expose canonical game state                                                                        | `ref:euchre-head-a81891b-planning-20260728` |
| Scope persistent state by session user ID  | A cookie identity change must never retain another user's projected hand, party, invite registry, polling, or stream   | Adversarial review 2026-07-28               |
| Persist the original accepted party invite | Only a retry of the same invite may return existing membership; unrelated invites must preserve the one-party conflict | Final authenticated-route review 2026-07-28 |
| Bind history data to its session identity  | Parent and child loader races must never render another session's projected history                                    | Final authenticated-route review 2026-07-28 |

## Phase 1: Contracts [COMPLETE]

- [x] 1.1 Add route tests for direct links, redirects, history, and return paths
- [x] 1.2 Define a serializable bootstrap with session, projected room, and party
- [x] 1.3 Add hidden-field assertions for all bootstrap data

## Phase 2: Route Structure [COMPLETE]

- [x] 2.1 Add a sign-in route and a pathless authenticated layout
- [x] 2.2 Move home, game, partner, and history routes under the layout without changing URLs
- [x] 2.3 Load bootstrap data before child routes
- [x] 2.4 Load history through its route loader
- [x] 2.5 Add stable route pending and error components

## Phase 3: Persistent Controller [COMPLETE]

- [x] 3.1 Split `App` into a persistent controller and leaf screens
- [x] 3.2 Seed room and party state from loader data
- [x] 3.3 Keep `acceptRoomUpdate` as the stale-update guard
- [x] 3.4 Keep the controller mounted during history navigation
- [x] 3.5 Key invite mutations so one navigation can execute them once

## Phase 4: Client Navigation [COMPLETE]

- [x] 4.1 Replace internal anchors and reloads with typed TanStack navigation
- [x] 4.2 Invalidate session data on sign-in and sign-out
- [x] 4.3 Preserve safe same-origin return paths through authentication
- [x] 4.4 Verify that preloading never runs join, leave, create, or invite mutations

## Phase 5: Adversarial Hardening [COMPLETE]

- [x] 5.1 Block stale bootstrap data when the route session user changes and invalidate active route caches
- [x] 5.2 Remount the persistent provider by user ID so room, party, invite registry, polling, and SSE state reset together
- [x] 5.3 Reject room and gone events unless the stream's captured room remains active
- [x] 5.4 Drop the old room and stream before switching routes, then activate the new room only after navigation
- [x] 5.5 Handle post-commit remount retries without accepting unrelated invites
- [x] 5.6 Cover identity changes, stale room events, provider remount retries, and one-party membership invariants

## Phase 6: Final Findings [COMPLETE]

- [x] 6.1 Return the session user ID and projected history from one authenticated middleware context and runtime
- [x] 6.2 Reject stale child history and invalidate route data when its identity differs from the parent session
- [x] 6.3 Persist accepted `(userId, inviteCode, partyId)` joins atomically before invite rotation
- [x] 6.4 Recheck same-invite idempotency and membership after waiting for the target party lock
- [x] 6.5 Preserve conflicts for unrelated invites while a user is already a party member
- [x] 6.6 Cover session-switch history races plus sequential, concurrent, new-runtime, and cross-party joins

## Completion Criteria

- Direct authenticated pages render with initial session and room data.
- History does not use a session-then-data client waterfall.
- Game to history to game navigation keeps room state and avoids a document reload.
- Loaders contain no hidden game data.
- Session identity changes cannot render cached bootstrap or child-route data from the previous user.
- Late events from a previous room cannot replace or clear the current room.
- Retrying a committed party join returns the existing party without consuming another invite.
- A different invite never succeeds merely because the caller already belongs to a party.

## Notes

- 2026-07-28: Current client loading starts in `src/App.tsx:57-95` after hydration. `ref:euchre-head-a81891b-planning-20260728`
- 2026-07-28: Implemented the authenticated layout, loader bootstrap, persistent multiplayer provider, typed navigation, and invite/privacy route tests.
- 2026-07-28: Hardened identity scoping, room stream switching, and idempotent party joins after adversarial review.
- 2026-07-28: Bound history responses to middleware session identity and replaced membership-based party retry behavior with durable original-invite records.
