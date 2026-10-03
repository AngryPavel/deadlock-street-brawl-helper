---
name: testmode-plan-round1
description: 2026-09-19 eval of the test-mode + circle-overlay plan; everything passed except the look — user wants green circle and "Score: " prefix
metadata:
  type: project
---

Test-mode plan (commit d8e692d) evaluated 2026-09-19: test mode, screenshot switching, turn-off and no-error-dialog all accepted by the user ("Works"). win:e2e 34/34 three times in a row, no flakes.

Verdict was replan: the user had asked for "white" for the item to take, saw it, and then said "I want the circle to be green, and I want the number score to have "Score: " before it so that it's more clear."

**Why:** the user judges overlay looks by eye and changes colour/label wishes after seeing them; the spec's white requirement, the vitest colour test and check-demo-png's `white-on-best` all encode the old wish.

**How to apply:** for overlay look criteria always show the live app, not only the PNG, and expect follow-up tweaks. Still open: whether only the best circle is green and whether the score text is green too. Supersedes [[project_visible_test_mode_wanted]] (test mode now exists and is accepted).
