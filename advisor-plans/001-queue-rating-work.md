---
status: complete
phase: 1
updated: 2026-07-28
---

# Queue Rating Work

## Goal

Remove rating calculation from game and read requests without losing or applying a rating twice.

## Context & Decisions

| Decision                                        | Rationale                                                                | Source                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| Use `rating_outbox` as the v2 durable outbox    | Old code cannot see or consume complete evidence from the new table      | Adversarial finding 1                             |
| Retain `pending_rating` only as a legacy intake | New consumers must recover rows committed by old application versions    | Adversarial finding 1                             |
| Use Queue messages as wake signals              | Queue delivery can repeat or arrive out of order                         | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |
| Keep `rated_match` as the idempotency claim     | It prevents two consumers from applying one result twice                 | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |
| Quarantine malformed work in `rating_outbox`    | A poison row must remain diagnosable without blocking newer valid work   | Adversarial finding 2                             |
| Use `src/worker.ts` for all Worker handlers     | Later Queue, scheduled, and Durable Object handlers need one entry point | `ref:euchre-hyperdrive-planning-f3f6b90-20260728` |

## Phase 1: Schema And Tests [COMPLETE]

- [x] 1.1 Add integration tests for pending evidence, duplicate delivery, and concurrent consumers
- [x] 1.2 Add nullable final hand evidence and a `createdAt` index to `pending_rating` in `src/db/schema/game.ts`
- [x] 1.3 Generate a new Drizzle migration with `bun run db:generate -- --name=queue-rating-reconciliation`
- [x] 1.4 Keep the old trigger during the mixed-version rollout; remove it in a later generated migration

## Phase 2: Reconciliation Module [COMPLETE]

- [x] 2.1 Extract pending persistence and oldest-first processing to `src/server/rating-reconciliation.server.ts`
- [x] 2.2 Lock one pending row, claim `rated_match`, lock ratings in user-ID order, update, and delete pending in one transaction
- [x] 2.3 Make match completion store history and complete pending evidence only
- [x] 2.4 Send an identifier-only Queue message after commit; a send failure must not fail gameplay

## Phase 3: Worker Handlers [COMPLETE]

- [x] 3.1 Add `fetch`, `queue`, and `scheduled` handlers to `src/worker.ts`
- [x] 3.2 Add Queue, DLQ, serial consumer, and five-minute cron configuration to `wrangler.jsonc`
- [x] 3.3 Limit each recovery scan to 100 oldest rows
- [x] 3.4 Generate Cloudflare binding types with `bun run cf-typegen`

## Phase 4: Remove Hot-Path Work [COMPLETE]

- [x] 4.1 Remove reconciliation from history, tick, current-room, and waiting-lobby reads
- [x] 4.2 Verify that queue payloads contain no cards, hands, or participant evidence
- [x] 4.3 Run unit, database integration, type, lint, format, and build checks

## Phase 5: Mixed-Version Hardening [COMPLETE]

- [x] 5.1 Add generated `rating_outbox` v2 schema and migration without changing older migrations
- [x] 5.2 Move trigger-created legacy work into v2 and delete the legacy row in the match transaction
- [x] 5.3 Consume the globally oldest eligible v2 or legacy row under advisory serialization
- [x] 5.4 Preserve `rated_match` idempotency and legacy claim-then-user-rating lock order
- [x] 5.5 Validate persisted mode, participants, forfeit, score, and every hand-result field
- [x] 5.6 Quarantine malformed work with a timestamp and non-sensitive failure code, then continue
- [x] 5.7 Cover mixed-version visibility, monotonic evidence, fallback, poison, concurrency, duplicates, and cross-source order with database integration tests
- [x] 5.8 Verify CI runs migrations and the full database-enabled quality suite on fresh PostgreSQL

## Phase 6: Evidence Boundary Hardening [COMPLETE]

- [x] 6.1 Match every non-null rating participant to the persisted history user in the same seat before claiming the match
- [x] 6.2 Validate complete hand evidence against Euchre scoring, lone-player, trick, sequence, and final-score invariants
- [x] 6.3 Quarantine participant and hand contradictions before `rated_match`, then continue to newer work
- [x] 6.4 Replace raw rating pipeline database and Queue errors with fixed non-sensitive boundary messages
- [x] 6.5 Add focused pure tests and database integration coverage for contradiction quarantine and continuation

## Phase 7: Final Adversarial Hardening [COMPLETE]

- [x] 7.1 Add a v2 migration barrier that redirects and suppresses old Worker claims of legacy rows
- [x] 7.2 Preserve redirected legacy timestamps and make the v2 consumer reselect globally oldest work in the same transaction
- [x] 7.3 Require final scores to contain one winner at 10..13 and one loser at 0..9
- [x] 7.4 Reject complete hand evidence when either team reached 10 before the final hand
- [x] 7.5 Cover old claim redirection, global cross-source order, same-call continuation, impossible scores, and early-win continuation

## Completion Criteria

- Match completion does not wait for rating row updates.
- Duplicate consumers change each rating once.
- Failed Queue sends recover from the database outbox.
- Hot room and history reads do not scan `pending_rating`.
- Old Workers cannot see v2 rows created by new match transactions.
- Old Workers cannot claim legacy rows after the v2 migration barrier is active.
- Malformed rows are quarantined without logging participant or hand evidence.

## Notes

- 2026-07-28: Current hot-path calls are in `src/server/game-service.server.ts:609-716` and `:888-936`. `ref:euchre-hyperdrive-planning-f3f6b90-20260728`
- 2026-07-28: Cloudflare Queue and DLQ resources were created before publication.
- 2026-07-28: Adversarial review kept the old trigger for safe mixed-version deployment and made consumers process the globally oldest pending row.
- 2026-07-28: Follow-up adversarial review required a separate v2 outbox because keeping complete evidence in `pending_rating` still exposed it to long-lived old Workers.
- 2026-07-28: Latest adversarial review required persisted-seat identity checks, complete Euchre evidence consistency, and sanitized errors at every new rating boundary before a match can be claimed.
- 2026-07-28: Final adversarial findings added a database claim barrier for long-lived old Workers and bounded persisted final scores and complete-evidence prefixes to reachable match outcomes.
