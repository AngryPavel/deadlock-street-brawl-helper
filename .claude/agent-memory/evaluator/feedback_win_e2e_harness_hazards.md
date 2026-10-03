---
name: feedback-win-e2e-harness-hazards
description: win:e2e safety and flake notes - kill-by-title fixed in e4ebb06; overlay-panel flakes ~2/7; run harness 6+ times, never trust 3 greens
metadata:
  type: feedback
---

Before `npm run win:e2e`, still do a read-only check that no real game is open:
`powershell.exe -NoProfile -Command "Get-Process | ? { $_.MainWindowTitle -eq 'Deadlock' }"`.

**Why:** Until commit `e4ebb06` (2026-09-18) the harness killed any window titled `Deadlock`. Round 6 verified the fix with a live decoy (guard runs first, `-Stop` is pid-file only). The check is now cheap insurance, not a blocker.

**How to apply:** The `overlay` case's `overlay-panel` check failed 2 of 7 runs in round 6 (`0/3 cards found`) while the worker reported 3/3 green, so run the harness at least 6 times before accepting "three in a row". Passing and failing runs had identical debug-log lines, so the log can't explain it. Timings: full run ~110 s, `--only boot,capture-denied,capture-found,overlay` ~60 s, `win:sync` fast now (npm ci skipped). Captured frame PNGs land only in `/mnt/c/Users/Jaxon/brawl-helper-win/logs/`. `win:demo` runs at opacity 0 and self-exits after 8 s; on-screen visibility can't be checked without a desktop grab (forbidden by AGENTS.md) - score BLOCKED with a manual step. Related: [[feedback-electron-runtime-verification]].
