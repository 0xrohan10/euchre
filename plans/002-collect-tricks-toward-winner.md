# 002 — Collect tricks toward the winner

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: MEDIUM
- **Category**: Physicality
- **Estimated scope**: 2 files, 35–55 lines

## Problem

Completed cards fade in place, while a separate timer clears state:

```css
/* src/App.css:88 */
.trick-area.complete .trick-card .playing-card {
  animation: collect-fade 180ms var(--ease-in-out) 1.36s forwards;
}
```

```tsx
// src/App.tsx:131
if (game.phase === 'trick-complete') {
  const timer = window.setTimeout(() => dispatch({ type: 'collect-trick' }), 1600)
  return () => window.clearTimeout(timer)
}
```

This happens five times per hand. The motion does not explain ownership, and CSS/JS timing can drift.

## Target

After 1300 ms of readable hold time, move all four cards toward the winning seat over exactly `220ms var(--ease-in-out)` while fading to zero and scaling to `.92`. Direction vectors:

```css
[data-winner='0'] {
  --collect-x: 0px;
  --collect-y: 150px;
}
[data-winner='1'] {
  --collect-x: -180px;
  --collect-y: 0px;
}
[data-winner='2'] {
  --collect-x: 0px;
  --collect-y: -150px;
}
[data-winner='3'] {
  --collect-x: 180px;
  --collect-y: 0px;
}
```

Use animation completion, not a second timeout, to dispatch `collect-trick`.

## Repo conventions to follow

- On-screen movement uses `--ease-in-out` from `src/App.css:13`.
- Player positions are already canonical numeric values in `trick-player-0` through `trick-player-3`.
- `game.lastTrickWinner` is the source of truth; do not infer the winner from DOM order.

## Steps

1. In `src/App.tsx`, remove the `game.phase === 'trick-complete'` timeout branch.
2. Add `data-winner={showingCompletedTrick ? game.lastTrickWinner ?? undefined : undefined}` to `.trick-area`.
3. Add an `onAnimationEnd` handler on `.trick-area`. Dispatch `collect-trick` only when `event.animationName === 'collect-to-winner'` and `event.target` is inside `.trick-card.winner`; ignore all other bubbled animations.
4. In `src/App.css`, replace `collect-fade` with `collect-to-winner 220ms var(--ease-in-out) 1300ms forwards` for normal and winning cards.
5. Define `collect-to-winner` from the card’s current transform to `translate(var(--collect-x), var(--collect-y)) scale(.92)` with `opacity: 0`.
6. Preserve the existing 260 ms winner confirmation as the first animation in the winner’s animation list.
7. Until plan 007 is applied, ensure the reduced-motion media query still runs a 200 ms opacity-only collection animation named `collect-to-winner`; otherwise animation completion will never dispatch.

## Boundaries

- Do not change scoring, winner calculation, the 1300 ms readable hold, player coordinates, or card-play entry animations.
- Do not add a motion dependency or another timer.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: complete tricks won by each of the four seats. Cards must move toward that seat, disappear together, and only then begin the next trick. At 10% playback, no card may jump before movement starts.
- Toggle reduced motion: cards must remain readable, fade for 200 ms without translation, and still advance the game.
- **Done when**: trick advancement is driven by the winner’s collection animation end and all four directions are correct.
