# 007 — Preserve feedback with reduced motion

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 1–2 files, 35–55 lines

## Problem

`src/App.css:282-290` sets every animation to `none`, removing useful deal/result/winner/trick-token feedback along with movement:

```css
@media (prefers-reduced-motion: reduce) {
  .playing-card.dealt,
  .card-back,
  .trick-card,
  .trick-card.winner .playing-card,
  .trick-area.complete .trick-card .playing-card,
  .trick-result,
  .won-trick-card { animation: none; }
}
```

## Target

Under reduced motion, remove translation, rotation, and scale while retaining opacity feedback for exactly `200ms var(--ease-out)`. Collection must still trigger the state transition introduced by plan 002.

## Repo conventions to follow

- This plan runs last and must cover selectors introduced by plans 002, 004, 005, and 006.
- No reduced-motion animation may use transform, blur, or parallax.

## Steps

1. Replace blanket `animation: none` with `reduced-fade-in` (`opacity: 0 → 1`, 200 ms `--ease-out`) for dealt cards, card backs, played cards, trick results, trick tokens, settings, bidding controls, hand results, match results, and score changes.
2. Keep winner confirmation static via its gold outline; do not pulse scale.
3. Define reduced collection as opacity `1 → 0` over 200 ms after the same 1300 ms hold. Preserve the animation name expected by plan 002’s completion handler, or update that handler to accept the explicit reduced name.
4. Remove playable-card lift and press scaling under reduced motion; state shadows/colors may still change immediately.
5. Ensure settings and bidding exits retain 200 ms opacity so their deferred unmount handlers still fire.
6. Do not disable functional transition completion events needed to advance state.

## Boundaries

- Do not change the default-motion experience, semantic timing, scoring, focus behavior, or dependencies.
- Do not use `animation: none` on any element whose animation end drives unmounting or game state.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: emulate `prefers-reduced-motion: reduce`; complete a deal, play and collect a trick, open/close settings, bid, finish a hand, and finish a match. Nothing may translate, rotate, or scale. Every state must remain understandable through a 200 ms opacity fade.
- Turn reduced motion off and confirm the default motion from all preceding plans is unchanged.
- **Done when**: reduced motion is movement-free, still informative, and no state machine waits forever for a removed animation.
