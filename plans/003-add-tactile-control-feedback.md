# 003 — Add tactile control feedback

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: LOW
- **Category**: Physicality and cohesion
- **Estimated scope**: 1 file, 15–25 lines

## Problem

Cards respond physically, but header, bid, result, and settings controls only change color. The settings thumb also uses generic easing:

```css
/* src/App.css:204 */
.rule-toggle > i::after {
  transition: transform 160ms ease;
}
```

## Target

Use `transform 120ms var(--ease-out)` and `scale(.97)` while pressing buttons. Change the switch thumb to `transform 160ms var(--ease-in-out)`.

## Repo conventions to follow

- Reuse `--ease-out` and `--ease-in-out`; add no tokens.
- Keep card press behavior at `src/App.css:115` unchanged.

## Steps

1. Add `transition: transform 120ms var(--ease-out)` to `.room-code`, `.icon-button`, `.invite-button`, `.primary-button`, `.quiet-button`, `.suit-buttons button`, `.hand-result button`, and `.rule-toggle > i` where applicable.
2. Add a shared `:active:not(:disabled) { transform: scale(.97); }` selector for the button classes above. Do not apply it to labels or disabled buttons.
3. Replace the switch thumb’s `ease` with `var(--ease-in-out)` while retaining 160 ms and 16 px travel.
4. In reduced motion, disable press scaling but keep the switch’s immediate checked position.

## Boundaries

- Do not change hover colors, click handlers, dimensions, focus outlines, card interactions, or markup.
- Do not use bounce or spring easing.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: mouse-press and touch-press every control type. The response must be immediate and subtle, return cleanly if released outside, and never move disabled controls.
- At 10% playback, scale must stay centered and never exceed `.97`.
- **Done when**: all actionable controls share the same press language and the switch uses the existing movement token.
