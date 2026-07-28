# Performance Implementation Stack

These plans form one pull request stack. Each implementation branch includes its matching plan.

| Order | Plan                                                        | Branch                      | Depends on        |
| ----- | ----------------------------------------------------------- | --------------------------- | ----------------- |
| 1     | [Queue rating work](001-queue-rating-work.md)               | `perf/queue-rating-work`    | Hyperdrive        |
| 2     | [Consolidate room snapshots](002-room-snapshots.md)         | `perf/room-snapshots`       | Plan 1            |
| 3     | [Improve asset delivery](003-asset-delivery.md)             | `perf/asset-delivery`       | Plan 2            |
| 4     | [Load authenticated routes](004-authenticated-routes.md)    | `perf/authenticated-routes` | Plan 3            |
| 5     | [Add live lobby events](005-live-events.md)                 | `perf/live-events`          | Plan 4            |
| 6     | [Improve interaction feedback](006-interaction-feedback.md) | `perf/interaction-feedback` | Plan 5            |
| 7     | [Add room coordinators](007-room-coordinator.md)            | `perf/room-coordinator`     | Plans 1, 2, and 5 |

Each branch must pass `bun run test`, `bun run typecheck`, `bun run lint`, `bun run fmt:check`, and `bun run build`.

Each branch must also pass an adversarial review before its pull request is published.
