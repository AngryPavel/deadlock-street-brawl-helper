---
name: hdt-overlay-plan-round1
description: 2026-10-03 HDT-style overlay/frameless window round 1 — drag/resize accepted; replan for in-game "app is running" indicator in lobby
metadata:
  type: project
---
2026-10-03: user accepted drag/resize ("Works"); skipped look/tooltip/real match. Asked for a subtle in-game indicator that the app is running, even in the lobby, and chose to send it to the planner. That conflicts with the "overlay blank outside draft" rule.

**Why:** user wants confidence the app is alive while in game.
**How to apply:** next round, check the indicator is visible in the lobby and unobtrusive. Local `npm run check` timed out twice in recognise/regions tests while CI passed; rerun before blaming the worker. win:demo refuses while the real game is open; the user may have Deadlock running during evals.
