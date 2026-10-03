---
name: feedback-electron-runtime-verification
description: Electron items must be checked at runtime; a headless minimal-main repro works on this WSL2 box even though the full app segfaults
metadata:
  type: feedback
---

Never score an Electron IPC/handler/preload item PASS from grep, typecheck or `build:electron` alone. Attempt a real launch, or mark BLOCKED.

**Why:** Item 2 of the street-brawl plan passed two rounds on grep/build while the deny path crashed for the user. In round 3 a runtime repro also found the preload never loads (ESM `import` rejected by Electron's preload loader, so `window.brawlAPI` is undefined) and the built UI is blank under `loadFile` (absolute `/assets` base). None of that is visible statically.

**How to apply:** On this WSL2 machine `npx electron .` segfaults headless, but a minimal CommonJS main script works: `npx electron <script>.cjs --ozone-platform=headless --no-sandbox --disable-gpu`, offscreen BrowserWindow, real `electron-dist/preload.js`, listen for `preload-error`, serve `dist/` with `npx vite preview` and `loadURL` it. Redirect output to a file (piping through `head` hung once). Example scripts: `plans/eval-artifacts/round-3/repro*.cjs`. First check is always `typeof window.brawlAPI`. Related: [[project-street-brawl-plan-round1]].
