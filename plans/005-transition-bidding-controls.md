# 005 — Transition bidding controls without layout jumps

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: LOW
- **Category**: Missed opportunity
- **Estimated scope**: 2 files, 35–50 lines

## Problem

`src/App.tsx:309-321` mounts bid controls abruptly. On mobile, `src/App.css:247-248` also changes dock minimum height from 62 px to 112 px, creating a visible jump.

## Target

Bid controls enter with opacity `0 → 1` and translateY `6px → 0` over `180ms var(--ease-out)`. They exit with opacity `1 → 0` and translateY `0 → 4px` over `160ms var(--ease-in-out)`. Mobile dock geometry must remain 112 px while bidding controls enter or exit; collapse only after exit completes.

## Repo conventions to follow

- `choosingTrump` remains the semantic source of truth.
- Retain the current centered dock, action ordering, disabled states, and `aria-live` behavior.

## Steps

1. Add a local rendered-controls phase (`'hidden' | 'entering' | 'visible' | 'exiting'`) derived from changes to `choosingTrump`.
2. Cache the last bidding phase (`'ordering' | 'calling'`) and its callable suits while visible so controls do not change content during exit.
3. Keep `.bid-controls` mounted through exit, set `inert` and `aria-hidden="true"` as soon as exit starts, and unmount on its own exit `animationend`.
4. Add `data-state` to `.bid-controls` and `.action-bar`.
5. Apply the exact target transforms, opacity, durations, and tokens. Animate no height, width, grid, or other layout property.
6. Keep mobile `min-height: 112px` during entering/visible/exiting, then return to 62 px only after controls are hidden.

## Boundaries

- Do not change bidding legality, action order, labels, bot delays, card motion, or desktop dock dimensions.
- Do not make exiting controls clickable or focusable.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: exercise order/pass/call/stick-dealer states at desktop and 390 px. Buttons must never show actions from the next phase, and mobile content below the dock must not move during the fade.
- Spam actions at normal speed; no stale click target may survive exit.
- **Done when**: controls enter/exit smoothly with no animated layout property and accessibility state matches visibility.
