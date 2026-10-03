---
name: release-plan-round1
description: 2026-10-03 release-ready build eval — automated criteria passed, but user wants a Hearthstone-Deck-Tracker-style redesign; replan
metadata:
  type: project
---
On 2026-10-03, round 1 of the release-ready build spec (slim UI, Ctrl+Shift+D debug panel, release.yml, data refresh) passed every check a command could decide. The worker never pushed the v0.2.0 tag or Release.

The user then rejected it as "not yet ready for release": the control window looks like a web page instead of an app, and moving or resizing it behaves strangely. They want the overlay to look generally like Hearthstone Deck Tracker's Battlegrounds overlay. Verdict: replan.

**Why:** the user judges the look and feel, and the redesign request is too big to go to the worker as an amendment.
**How to apply:** next round, show the user the window chrome and move/resize behaviour early. Don't treat the release as shippable until a real tag/Release exists with two .exe assets. Related: [[visible-test-mode-wanted]].
