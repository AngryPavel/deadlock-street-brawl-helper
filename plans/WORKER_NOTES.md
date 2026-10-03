# Worker notes (Detect now F8 + lobby status dot)

Launch: `npm run win:dev` (button next to Start capture; F8 once a Deadlock/test-mode window exists). `npm run win:e2e`, `npm run win:demo -- choice1`.

**Blocker: a real Deadlock (pid 53168, D:\SteamLibrary\...\deadlock.exe) was open the whole session.** `win:e2e` and `win:demo` refuse to run (`real-game-open`) and I did not close your game. So NOT run this session: the new e2e checks (`dot-drawn-lobby`, `dot-hover-line`, `dot-hover-leaves-clickthrough`, `detect-miss`, `detect-hit`, `f8-registered`; written in `scripts/win/e2e-main.cjs`, unexecuted), the full e2e <30 s / advice-time check, and the demo PNG regeneration (choice1, choice2, draft-r2c3-reroll). Close Deadlock, then run `npm run win:e2e` and the three `win:demo`s.

Observed this session (Linux side):
- Detect now: button beside Start, disabled + "Deadlock not found" without a game (component test passes). One-try logic, F8, tray, hold-after-miss written; NOT run on Windows.
- F8 register only while a game window exists: unit test on `shouldRegisterDetectKey` passes. `detect.manual` e2e line: not run.
- Dot state machine: 5 unit tests pass (found, hidden on draft, back after 10 min / lost+found, foreground, colour). Overlay drawing/hover: written, not run.
- `npm run check` ran green 3 times in a row (12-13 s each); 115 tests. `brawl:see -- --fixtures` 27/27.
- Slow tests: recognise.test 1.8 s and regions.test ~1 s per test alone; they pass 5 s only under parallel load. Added `vi.setConfig({ testTimeout: 20_000 })` in both files, no assertion touched.
- AGENTS.md and the wiki (Windows-App page, pushed) describe F8 and the dot.

Automatic-miss diagnosis (req 9): ran the real probe (`probeShopScreen`) on demo + `screenshots/` frames scaled to 1280-2560 px wide. Cause reproduced and fixed: CHOICE-1 frames missed at 1312 and 1600 px wide (4 of ~160 draft cases) because a stray lit pixel at the glyph box edge stretched its bounding box; `readDigit` now retries ignoring single-pixel columns. After: 0 draft misses, 0 false hits on `gameplay`/`inround-r3` at every width 1280-2560 (step 32); fixtures 27/27; regression test `probe-scales.test.ts`. Not reproduced / unverified: foreground gating and the GDI screen grab against a real Deadlock (needs a hand check; the new `draft.probe.miss` log line (`not-foreground` / `glyph-not-read`) will show which in a real session's log). No grab-null log added (grab failure currently reads as glyph-not-read).

Not done: no `v0.2.0-rc.2` tag (e2e/demo not run, so not every automated criterion passed). Real-match and lobby checks are yours.
