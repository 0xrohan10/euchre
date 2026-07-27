# 006 — Animate hand and match results

- **Status**: TODO
- **Commit**: `0e0be33`
- **Severity**: LOW
- **Category**: Missed opportunity
- **Estimated scope**: 2 files, 25–40 lines

## Problem

The trick result animates, but `.hand-result` at `src/App.css:97` and the match-over `Play again` action at `src/App.tsx:322` appear instantly. Score values also snap during these rare, high-emotion moments.

## Target

- Hand result: opacity `0 → 1`, translateY `8px → 0`, scale `.97 → 1`, `220ms var(--ease-out)`.
- Match-over action: same motion, `220ms var(--ease-out)`.
- Changed score numeral: opacity `.55 → 1`, translateY `4px → 0`, `180ms var(--ease-out)`.
- No confetti, bounce, blur, count-up, or repeated looping.

## Repo conventions to follow

- Reuse `result-in` only if extending it does not change `.trick-result`; otherwise add named keyframes.
- Preserve `font-variant-numeric: tabular-nums` and all scoring logic.

## Steps

1. Add a dedicated `hand-result-in` animation with the exact target values.
2. Add a `match-result` class to the match-over button or a minimal wrapper, and apply the same animation.
3. Key each `.score` element by team plus current score so only a changed numeral remounts and runs `score-change-in` once.
4. Define `score-change-in` with the exact target values; do not animate score color or layout.
5. Ensure starting a new hand or match removes old result nodes before the next animation.

## Boundaries

- Do not alter score timing, text, buttons, card collection, sounds, or rules.
- Do not animate routine trick totals; only match score numerals and hand/match result surfaces.

## Verification

- **Mechanical**: `bun run test`, `bun run lint`, `bun run build`.
- **Feel check**: finish a made bid, euchre, march, and match. Each result enters once, never loops, and remains readable immediately. At 10% playback, origin must be centered with no overshoot.
- **Done when**: hand and match milestones receive one restrained confirmation and normal play remains unchanged.
