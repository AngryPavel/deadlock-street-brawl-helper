---
name: project-street-brawl-hero-capture-reroll-plan-round1
description: Round 1 eval of the "Fix capture-on-hero-change and self-capture, add ability order, clearer re-roll advice" plan — 7/7 items passed
metadata:
  type: project
---

Plan "Fix capture-on-hero-change and self-capture, add ability order, clearer re-roll advice"
(drafted 2026-09-18) passed all 7 items in round 1, no rerun needed.

**Why:** worker fixed the video-unmount-on-hero-change bug, tightened Electron window matching to
exact title, added Street Brawl ability-order data/panel, made hero auto-detect visible via logs
and an "auto" badge, added a RE-ROLL banner + boxed the actual re-roll button, drew advice on an
Electron overlay panel with a demo mode, and swept docs/AGENTS.md.

**How to apply:** the only wrinkle was the item-3 endpoint one-liner (counts files missing
`ability_order_stats`) returning `1` instead of `0` because it doesn't exclude
`public/data/analytics/brawl/tier-list.json` (a hero-list aggregate, not a per-hero file) — this
is a plan wording gap, not a worker defect; graded PARTIAL with full explanation rather than FAIL.
If this plan or a similar ability-order plan recurs, flag to the planner that the endpoint should
filter to per-hero-id files.

Windows-only rubrics (items 2 and 6: real window capture matching, always-on-top re-assertion,
Ctrl+Shift+D click-through) are pre-declared unverifiable from WSL2 per `AGENTS.md` — verify via
`tsc -b` + `npm run build:electron` exit 0 and unit tests of exported pure helpers
(`isGameWindowTitle`) instead of treating as blocked/failed.

See also [[project_street_brawl_plan_round1]] for the earlier, separate plan round in this repo
(different scope: capture bring-up, Electron overlay packaging, data refresh — not this plan).
