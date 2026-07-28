# 001 — Stop animating card shadows

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 1 file, under 10 lines

## Problem

Every playable-card state change repaints the shadow for every legal card. `src/App.css:114` currently says:

```css
button.playing-card.playable {
  --card-y: -8px;
  box-shadow:
    0 0 0 2px var(--gold),
    0 8px 18px rgba(0, 0, 0, 0.3);
  transition:
    transform 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}
```

This is a high-frequency interaction. `box-shadow` is paint-bound; only transform and opacity should animate.

## Target

Keep every existing resting and hover shadow, but make shadow changes immediate:

```css
button.playing-card.playable {
  transition: transform 150ms var(--ease-out);
}
```

## Repo conventions to follow

- Easing tokens are in `src/App.css:12-13`.
- The fine-pointer hover gate at `src/App.css:138-140` is correct and must remain.

## Steps

1. In `src/App.css`, remove only `box-shadow 150ms var(--ease-out)` from the playable-card transition.
2. Keep the playable, hover, invalid, and winner shadow values unchanged.

## Boundaries

- Do not change card geometry, lift distance, colors, shadows, JSX, or dependencies.
- If the cited selector has drifted, stop rather than broadening scope.

## Verification

- **Mechanical**: run `bun run test`, `bun run lint`, and `bun run build`; all must pass.
- **Feel check**: hover legal cards repeatedly at normal speed and 10% DevTools playback. Lift must remain smooth; the gold/shadow state may snap but must not flicker.
- **Performance check**: Chrome Performance with paint flashing should show no continuously repainted shadow during the 150 ms lift.
- **Done when**: transform is the only transitioned card property and visual resting states are unchanged.
