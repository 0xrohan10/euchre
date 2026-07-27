# Animation Improvement Plans

These plans audit source revision `0e0be33`. Before execution, compare every cited excerpt with the current source and stop on drift.

| Plan | Title | Severity | Status | Depends on |
| --- | --- | --- | --- | --- |
| 001 | Stop animating card shadows | MEDIUM | TODO | — |
| 002 | Collect tricks toward the winner | MEDIUM | TODO | — |
| 003 | Add tactile control feedback | LOW | TODO | — |
| 004 | Animate the settings sheet | LOW | TODO | — |
| 005 | Transition bidding controls without layout jumps | LOW | TODO | — |
| 006 | Animate hand and match results | LOW | TODO | — |
| 007 | Preserve feedback with reduced motion | MEDIUM | TODO | 002, 003, 004, 005, 006 |

## Recommended Execution Order

1. `001-stop-animating-card-shadows.md`
2. `003-add-tactile-control-feedback.md`
3. `002-collect-tricks-toward-winner.md`
4. `004-animate-settings-sheet.md`
5. `005-transition-bidding-controls.md`
6. `006-animate-hand-and-match-results.md`
7. `007-preserve-feedback-with-reduced-motion.md`

Run plan 007 last because it must cover every animation and animation-driven completion boundary introduced by the other plans.
