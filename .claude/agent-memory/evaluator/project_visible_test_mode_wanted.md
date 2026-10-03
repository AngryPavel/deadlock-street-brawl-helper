---
name: visible-test-mode-wanted
description: 2026-09-19 eval — user wants an on-screen dummy "Deadlock" test mode, circle-sized boxes and per-item scores; win:demo PNG is not enough
metadata:
  type: project
---

On 2026-09-19 the user rejected the no-game testing story: "I want there to be a test mode that brings up the
dummy 'Deadlock' that I can test the app out on". An invisible `win:demo` that only writes `logs/win-demo.png`
does not satisfy them. They also asked for overlay boxes around the item's circle (not the icon square) and
the engine's score shown above each item. Ctrl+Shift+D under `win:dev` showed no backdrop for them, and
crashes with "Object has been destroyed at triggerOverlayDemo" after the overlay window is closed.

**Why:** this pulls against [[project_harness_plan_round7]], where they rejected a fake window popping over
their windows during automated runs. The difference: an automated harness must stay hidden; a test mode they
launch on purpose must be visible.

**How to apply:** when evaluating any "test without the game" work, launch it and have the user look at their
actual screen; a PNG artifact passing pixel checks is not acceptance. See also
[[feedback_electron_runtime_verification]].
