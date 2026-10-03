---
name: harness-plan-round7-magenta
description: Round 7 of the Windows-harness plan; user rejected outcome because the fake Deadlock window is still magenta in capture-found and pops over their windows
metadata:
  type: project
---
Round 7 (2026-09-18): 3 full win:e2e runs green, but user reported the fake window still shows solid magenta ~1/3 of runs and covers their windows. Cause: plan item 3 kept magenta for `not-self` (e2e-main.cjs capture-found spawns fake-deadlock.ps1 without -Image); window is shown normally then demoted in Add_Shown, so it can flash on top. Recorded as plan_gap; replan loop exhausted (round 2).
**Why:** passing checks did not catch a visible-on-desktop problem; no check measures z-order/foreground.
**How to apply:** for any harness that opens real windows, ask what the user sees on the desktop, and treat "never steals focus" claims as unverified unless a foreground-window check exists. See [[feedback_win_e2e_harness_hazards]].
