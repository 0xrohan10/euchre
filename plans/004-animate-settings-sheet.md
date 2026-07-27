# 004 — Animate the settings sheet

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: LOW
- **Category**: Missed opportunity
- **Estimated scope**: 2 files, 45–65 lines

## Problem

`src/App.tsx:326-344` conditionally mounts the settings scrim and panel with no entrance or exit. On mobile this is a bottom sheet, but it appears at full size without spatial origin.

## Target

- Scrim: opacity `0 → 1`, `180ms var(--ease-out)`.
- Desktop panel: opacity `0 → 1`, translateY `8px → 0`, scale `.96 → 1`, `180ms var(--ease-out)`.
- Mobile panel (`max-width: 600px`): opacity `0 → 1`, translateY `20px → 0`, no scale, `220ms var(--ease-out)`.
- Exit: reverse with `160ms var(--ease-in-out)`; keep mounted until exit ends.

## Repo conventions to follow

- Settings ownership remains in `App.tsx`; CSS stays in `App.css`.
- Escape, backdrop, and close-button paths must call one shared close function.
- Never use `scale(0)`.

## Steps

1. Replace `settingsOpen` with mounted/open phase state: `'closed' | 'opening' | 'open' | 'closing'`.
2. Add `openSettings` and `closeSettings`; make every current close path call `closeSettings`.
3. Render the dialog unless phase is `closed`; add `data-state={settingsPhase}` to scrim and panel.
4. Move to `open` on the next animation frame after mounting. On the scrim’s own exit `animationend`, set phase to `closed`; ignore bubbled child animation events.
5. Preserve body scroll locking for every phase except `closed` and restore the prior overflow exactly once.
6. Add the exact desktop/mobile keyframes and durations above.
7. Prevent repeated close calls while already closing; reopening during exit must reverse from the current visual state rather than duplicate listeners.

## Boundaries

- Do not change dialog content, rules, persistence, focus semantics, backdrop-click behavior, or dependencies.
- Do not animate blur; keep `backdrop-filter: blur(8px)` static.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: open/close by gear, X, backdrop, and Escape at desktop and 390 px. Spam open/close; no flash, duplicate panel, stuck scroll lock, or stale focus.
- At 10% playback, desktop scales from center and mobile rises from the bottom edge.
- **Done when**: all close paths animate and unmount only after the exit completes.
