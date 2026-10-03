---
name: project-street-brawl-plan-round1
description: Round 1 eval outcome for the "harden street brawl helper" plan — passed 7/7 on paper, but a later round found the item-5 callback({}) deviation actually crashes at runtime
metadata:
  type: project
---

Round 1 of the "Harden the Street Brawl helper" plan (items 1-7) was scored 7/7 on 2026-09-17 using
grep/typecheck/build endpoints only — no display was available to actually launch the Electron app.

**CORRECTED 2026-09-18:** the item-5 deviation noted below (`callback({})` instead of the plan's literal
`callback(null)` in `electron/main.ts`'s `setDisplayMediaRequestHandler` deny path) was marked
"justified" purely from reading `tsc -b` type constraints. The user later ran the actual built app with
no Deadlock window open and got a crash (`UnhandledPromiseRejectionWarning` at the exact `callback({})`
call site, error text truncated but ending "...was not provided"), surfaced to the UI as generic
"Error starting capture" instead of the plan-required "Deadlock window not found." See
`plans/EVAL.md` round 2 (amended) for the full trace correlation. Root cause not yet fully confirmed —
`node_modules/electron/electron.d.ts` shows `callback({})` does type-check (Streams' `video`/`audio`
are both optional), so the crash may be in `desktopCapturer.getSources()` itself on this host rather
than the callback shape; needs a re-run with the un-truncated error text.

**Why this matters:** `tsc -b` passing and a grep-based plan endpoint passing are not evidence that an
Electron IPC callback behaves correctly at runtime. This exact gap survived two evaluation rounds
because neither attempted to launch the built app, even in the constrained way that would have been
possible (e.g. `xvfb-run npx electron electron-dist`) before defaulting to "Windows-only at runtime, ceiling is `build:electron`."

**How to apply:** never mark an Electron main-process IPC handler (anything wired through
`ipcMain`/`session.default Session.set*RequestHandler`) as PASS based on typecheck/grep alone. At
minimum, try a headless/off-screen launch of the built app and watch stdout for
`UnhandledPromiseRejectionWarning` or uncaught exceptions during the specific code path the item claims
to fix, before falling back to "Windows-only, can't verify from here." If genuinely no launch is
possible in the evaluator's environment, say so explicitly as a BLOCKED item requiring the user to run
it manually — do not silently upgrade it to PASS on the strength of adjacent unit tests.
