---
status: complete
phase: 5
updated: 2026-07-28
---

# Improve Asset Delivery

## Goal

Serve the font and smaller card images from the application and load cards in user-visible priority order.

## Context & Decisions

| Decision                               | Rationale                                             | Source                                    |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Keep the Inter variable font           | The UI uses fractional font weights                   | `ref:task-euchre-assets-a81891b-20260728` |
| Verify card images by rendered pixels  | SVG metadata removal must not change artwork          | `ref:task-euchre-assets-a81891b-20260728` |
| Use `?no-inline` for card imports      | Small optimized SVGs must remain separately cacheable | `ref:task-euchre-assets-a81891b-20260728` |
| Warm cards only after the table mounts | Auth and lobby traffic must not download the deck     | `ref:task-euchre-assets-a81891b-20260728` |
| Ship all nine static Inter weights     | Non-variable browsers must retain the `Inter` branch  | Adversarial review, 2026-07-28            |
| Cache only completed image loads       | Failed and cancelled warm-ups must remain retryable   | Final asset review, 2026-07-28            |
| Throttle the timer-based idle fallback | Browsers without idle callbacks must not burst a deck | Final asset review, 2026-07-28            |
| Verify provenance inside `cf:build`    | Direct Workers Builds must receive the same gate      | Final asset review, 2026-07-28            |

## Phase 1: Reproducible Card Assets [COMPLETE]

- [x] 1.1 Add deterministic SVGO generation and pixel-exact verification scripts
- [x] 1.2 Pin the source artwork and optimization tools
- [x] 1.3 Copy only the 27 used images into `src/assets/cards`
- [x] 1.4 Preserve LGPL attribution and license files
- [x] 1.5 Verify exact rendered output at current display sizes and DPR 1 and 2

## Phase 2: Local Font [COMPLETE]

- [x] 2.1 Vendor the official Inter 4.1 variable WOFF2 and OFL license
- [x] 2.2 Remove the external `rsms.me` CSS import
- [x] 2.3 Preserve the current family name, weight range, optical sizing, and feature settings

## Phase 3: Runtime Imports [COMPLETE]

- [x] 3.1 Replace `cardsJS` runtime imports with local `?no-inline` imports
- [x] 3.2 Keep the current `cardImage`, back, and score-image APIs
- [x] 3.3 Export stable playable-card URL helpers for warm-up

## Phase 4: Priority Loading [COMPLETE]

- [x] 4.1 Add an SSR-safe, dependency-injected idle image loader
- [x] 4.2 Load the visible hand and turned card with high priority
- [x] 4.3 Load remaining faces in small low-priority idle batches
- [x] 4.4 Cancel scheduled work on unmount and deduplicate URLs

## Phase 5: Adversarial Hardening [COMPLETE]

- [x] 5.1 Ship LGPL/GPL texts, attribution, provenance, and a dated derivative notice
- [x] 5.2 Assert that deployed cards, fonts, and legal files byte-match tracked sources
- [x] 5.3 Verify all 27 independently pinned upstream card hashes before regeneration
- [x] 5.4 Make verification, deterministic regeneration, and drift detection mandatory in CI
- [x] 5.5 Add a finite idle timeout with starvation and deadline-semantics tests
- [x] 5.6 Vendor and verify the official Inter 4.1 static WOFF2 fallback family
- [x] 5.7 Keep full-deck warm-up stable across room snapshots and deduplicate requests across remounts
- [x] 5.8 Pin canonical legal-file hashes and validate structured notices in source and production

## Phase 6: Final Asset Findings [COMPLETE]

- [x] 6.1 Separate session-completed and in-flight image URLs
- [x] 6.2 Mark completion only on load and release failed or cancelled URLs for remount retries
- [x] 6.3 Prevent duplicate concurrent requests across warm-ups
- [x] 6.4 Pace the no-`requestIdleCallback` fallback at two images every 200ms without claiming timeout
- [x] 6.5 Run `assets:verify` before migrations and Vite in the non-recursive `cf:build` script
- [x] 6.6 Cover success, transient failure, cancellation, remount, concurrency, fallback timing, and build ordering

## Completion Criteria

- Production makes no request to `rsms.me`.
- All card images render exactly like the source files.
- Aggregate card bytes decrease.
- Visible cards load before unused cards.
- The build emits separate hashed font and card files.
- The deployed client includes complete third-party legal and provenance files.
- CI rejects changed upstream inputs and nondeterministic generated-card drift.
- Browsers without variable-font support continue to use local Inter files.

## Notes

- 2026-07-28: The 27 current SVGs total about 1.62 MB raw and 669 KB gzip. `ref:task-euchre-assets-a81891b-20260728`
- 2026-07-28: Implemented pinned generation and 378 pixel comparisons. Optimized SVGs total 1,491,254 bytes raw and 633,741 bytes gzip, down 130,622 raw bytes (8.1%) and 35,754 gzip bytes (5.3%).
- 2026-07-28: Hardened all four adversarial findings. Verification now pins every cardsJS 1.1.1 input SVG and all ten Inter files; production asserts 27 cards, 10 fonts, and 6 legal/provenance files in Wrangler's deployed client directory.
- 2026-07-28: Closed the final asset findings. Full-deck idle work no longer restarts with 900ms room snapshots, remounts retain session request progress, and fake-time coverage proves all deferred URLs are requested once. Canonical GNU GPL/LGPL, Inter OFL, and upstream AUTHORS hashes are pinned; exact structured attribution and provenance fields are checked in tracked and deployed content.
- 2026-07-28: Closed three follow-up findings. The session cache now records only successful loads while separately suppressing concurrent duplicates; errors and stopped warm-ups remain retryable. The timer fallback starts two images every 200ms and reports a non-timeout deadline. The actual Cloudflare build script verifies asset provenance before any migration or Vite work, with an ordering and recursion assertion.
