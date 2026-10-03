# AGENTS.md — Deadlock Street Brawl Helper

Repo constitution for planner / worker / evaluator agents. Overrides generic stack defaults.

## Stack (do not switch)

- npm (not Bun/pnpm), Node 20+ locally, Node 24 in CI. Vite 8 + React 19 + TypeScript 6, plain CSS in `src/index.css`.
- Lint: oxlint (`.oxlintrc.json`). Format: Prettier. Tests: vitest. Typecheck: `tsc -b` over
  `tsconfig.app.json` / `tsconfig.node.json` / `tsconfig.electron.json` / `tsconfig.scripts.json`
  (all `strict`); the last one covers `scripts/*.ts` (the CLI, the recogniser, and their tests).
- Desktop: Electron 33 + electron-builder + koffi (Win32 window rect). Windows-only at runtime. Launch and
  verify with the `win:*` npm scripts from WSL (see below) — they sync to and run from a native Windows path
  because koffi and Electron don't work reliably over `\\wsl$\`. `npm run dev:electron` run directly inside
  WSL boots Linux Electron under WSLg instead of Windows Electron: `findGameWindow`/capture always return
  null there, and `main.ts` logs `platform.unsupported` (surfaced in the status line) when
  `process.platform !== 'win32'`. Running `dev:electron` from an actual Windows terminal, inside the synced
  Windows copy, also works.
- Data: static JSON + webp under `public/data/`, produced by `scripts/fetch-data.mjs` from deadlock-api.com.
  No backend, no database, no secrets, no `.env`.

## Commands

- `npm run check` — lint + typecheck + prettier --check + vitest; CI runs this before deploy.
- `npm run brawl:see -- --fixtures` — recogniser accuracy on `scripts/fixtures/` (must stay 27/27).
- `npm run brawl -- --hero 1 --round 2 --set "…"` — engine CLI without the screen reader.
- `npm run fetch-data` — full brawl refresh (~1400 requests, ~9 min), run by hand before a release; there is no
  scheduled refresh workflow. Assets come from `api.deadlock-api.com/v1/assets` (the old `assets.` host is gone).
- Release: push a `v*` tag; `.github/workflows/release.yml` builds the portable exe + NSIS installer on windows-latest
  and attaches them to the GitHub Release. No Pages deploy exists.
- `npm run win:setup` — once per machine; installs Node on the Windows side via winget (may prompt UAC).
- `npm run win:sync` — rsyncs the repo to `/mnt/c/Users/<user>/brawl-helper-win` and builds there. Never
  `rsync --delete` over that copy's `node_modules`; it's gitignored and stays out of this repo.
- `npm run win:dev` — the actual way to run the app from WSL: syncs, then launches real Windows
  `electron.exe` from the Windows copy.
- `npm run win:e2e [-- --only <case1,case2>]` — drives real Windows `electron.exe` end to end (boot,
  capture-denied, test mode: advice/boxes/frame switches/ability points panel/blank overlay) and writes
  `logs/win-e2e.json`. Cases are `boot`, `capture-denied`, `testmode`, `overlay-closed`. The
  ability panel runs 1.2 s in the harness (`BRAWL_TIP_MS`), not the real 15 s. Target: a full run under 30 s; the
  harness's own hard timeout is 40 s. It needs a >= 1080p desktop (see Overlay behaviour). Don't touch a window it didn't
  create. `--only selftest-fail` is a deliberately failing case that proves the harness can fail — it never
  runs as part of the default full run.
- `npm run win:demo -- choice1|choice2` — no real Deadlock window needed: starts the app's own **test mode**
  (below) with that screenshot, runs it through the real find/capture/recognise/advise/draw path, and saves
  the overlay's own composited output to `logs/win-demo.png`. Refuses to run if a real "Deadlock" window is
  already open (same guard as `win:e2e`). Verify with `npx tsx scripts/win/check-demo-png.ts logs/win-demo.png`
  (`frame-visible: true`, `plates-placed: true`, `teal-on-best: true`, `teal-on-non-best: false`; every offered card has a plate with its tier
  letter and `Score: <n>` above it; the item to take has a teal-filled plate and a 3 px teal circle outline, the others a charcoal plate with a thin teal border).
  It also writes `logs/win-demo.json` (what the overlay drew). Any `public/demo` frame name works, e.g. `win:demo -- draft-r2c3-reroll` -> `logs/win-demo-<name>.png` or by opening the PNG. Nothing is
  visible on the desktop while this runs: it sets `BRAWL_E2E=1` internally (to reach the `__brawlE2E` test
  hook), which keeps the dummy at the bottom of the z-order and the overlay at opacity 0. `logs/win-demo.png`
  (a real canvas rasterisation of the overlay, not a screen grab) is the only output. To see it live, use test
  mode in a normal `npm run win:dev` session.

## Which tests to run

`npm test` (vitest, 125 tests, already the whole suite) takes ~3 s wall: run it after any code change; run one file with
`npx vitest run <file>`. `npm run check` before pushing. `npm run win:e2e` (~30 s, drives real Windows) only when
capture, overlay, worker or Electron code changed, and only once per session. Docs/comments: run nothing.
All e2e-needing checks belong in the single `testmode` pass in `scripts/win/e2e-main.cjs`, asserted against
that one session; do not add a new case or a second app launch. Commands live in `.claude/test-commands.sh`.

## Debug panel

The control window is slim (hero header, Start/Stop capture, status line, how-to) plus the Tier List tab. Ctrl+Shift+D
(or the tray entry "Debug panel", channel `debugToggle`) toggles a hidden Debug panel with test mode, round/choice/
re-rolls, enemies, owned, advice list, ability order. Not persisted. `win:e2e`/`win:demo` open it before using those controls.

## Window and overlay look

The control window is frameless with an app-drawn 32 px strip (`TitleBar.tsx`, `-webkit-app-region: drag`; buttons `no-drag`, minimise/close over IPC), no menu bar. Size/position persist to `userData/window-state.json` (`electron/windowBounds.ts` validates; off-screen -> centred on the primary display; skipped under `BRAWL_E2E` and while test mode's temporary bounds are active). The identity (charcoal, teal `#2ec4b6`, warm off-white, <=4 px corners) lives once in `src/index.css` variables; `readTheme()` in `draw.ts` reads them for the canvas. The overlay draws a plate (tier letter + `Score: n`) above each card; hovering a plate shows `ScoreTip` (rows from `breakdownRows`, in `OverlayAdvice.rows`, summing to the score). The overlay stays click-through (`setIgnoreMouseEvents(true, {forward:true})`); hover is hit-tested in the overlay renderer and only while a draft shows. Under DPI scaling like 125 %, `getBounds` after `setBounds` differs by 1-2 px (rounding); the e2e allows that and checks for drift.

## Test mode

On a real desktop the dummy window opens at the left edge of the work area and the control window is resized to
fill the right side (`arrangeSideBySide`); closing test mode restores the control window's bounds. Under `BRAWL_E2E`
nothing is moved.

The control window's **Test mode (dummy Deadlock window)** button (`BrawlView.tsx`, state owned by
`startTestMode`/`stopTestMode` in `electron/main.ts`) opens a frameless dummy window titled exactly `Deadlock`,
sized 1920x1080 _physical_ px (the recogniser needs ~1080p to read the round/choice glyphs), showing one of
`public/demo/*.png`. The normal path runs against it; the **Screenshot** select switches the image live. It
refuses (message in the control window) when a real Deadlock window exists, auto-stops if one appears, and
closes only the window it opened. While on, the display-media handler serves only the dummy's own
`getMediaSourceId()` (desktopCapturer never lists the app's own windows, so it can't be found through the
source list) — nothing else can be captured. The old keyboard-shortcut demo and its tray entry no longer exist.

## Overlay behaviour (blank outside the draft)

- The overlay draws nothing, and its window is hidden (`syncOverlay` in `electron/main.ts`), unless the item draft
  screen is on the frame (`OverlayState.draft`) or the ability points panel (`OverlayState.panel`) is showing
  (`overlayHasContent`, `src/brawl/overlayContent.ts`). The panel is an HTML picture of the game's ability upgrade
  panel (`src/components/AbilityPanel.tsx`, data from `abilityPanelFor` in `src/brawl/abilities.ts`) for 15 s after
  the draft screen closes (`src/brawl/abilityPanelTimer.ts`, a pure state machine); a reopened draft ends it at once.
  It shows this round's standard points highlighted (Street Brawl gives 6/6/5/5/10 points in rounds 1-5; pills cost 1/2/5; `pillRounds` in `abilities.ts` follows the standard order, carries unspent points, and fills leftovers so all 32 are spent by round 5), earlier rounds' greyed with a check, later ones plain, with a "Round N: X points" title. Every ability starts unlocked in Street Brawl: there is no unlock advice anywhere.
- No yellow outline: Windows Graphics Capture draws one; `disable-features=AllowWgcWindowCapturer` (in
  `electron/main.ts` and both harnesses) falls back to Chromium's GDI window capturer, which has none. Keep that
  switch in all three places.
- `findGameWindow` caches the game's handle and only re-enumerates windows when it is gone; the cached path must
  still honour the `exclude` set (test mode's dummy is excluded by the poll that watches for a real game).
- Test mode's dummy is resized to 1920x1080 physical with `SetWindowPos` when the display is smaller (Electron
  clamps to the work area). Window capture still returns at most screen size, so on a display below ~1080p the
  recogniser cannot read the frame and the layout checks in `win:e2e` fail: run the harness on a >= 1080p desktop.

## Manual checks (the harness can't cover these)

Do these by hand on real Windows with a real Deadlock client at least once per release, since nothing
in `win:e2e`/`win:demo` drives the actual game:

- Start Deadlock in both **Borderless Windowed** and real **Fullscreen** (Video settings). The overlay
  must actually appear on top of the game in borderless; in true fullscreen exclusive mode it may not
  (this is a Windows/game limitation, not something the app can fix — confirm the app at least doesn't
  crash or mis-detect the window in that mode).
- Test mode on real Windows with no game open: press the button, confirm the dummy and overlay are visible and
  aligned at your display scaling, switch screenshots, turn it off. Close the overlay window and confirm no
  tray/menu entry or the test-mode button raises an error dialog.
- Play (or replay) a real Street Brawl draft end to end and confirm the advice box tracks the actual
  draft screen, re-roll banner appears when expected, and the box genuinely feels click-through (clicks
  through the overlay reach the game underneath, no accidental focus steal).

## Conventions

- Logging goes through `src/log.ts` (JSON lines to console). No bare `console.*` in `src/` or `electron/`.
- Commit messages: imperative sentence, no type prefix (see `git log`). Pushing to main is pre-approved.
- Persisted UI state (hero, tab, round, enemies) goes through `src/hooks/usePersisted.ts`
  (`localStorage` under the `brawl.` key prefix, validated with a type guard on read — no Zod here).
- `<App/>` and `<OverlayApp/>` are wrapped in `src/components/ErrorBoundary.tsx` (in `main.tsx`); it
  logs `ui.error` via `src/log.ts` and shows a Reload button instead of a blank page.
- Electron IPC channel names live in `electron/channels.ts`, imported by both `main.ts` and
  `preload.ts` — add new channels there, not as string literals.
- `electron/main.ts`'s display-media handler must never fall back to an arbitrary capture source when
  the Deadlock window isn't found; it denies the request and tells the renderer via the
  `capture-denied` channel instead.
- Never edit `public/data/**` or `scripts/fixtures/**` by hand except `manifest.json` metadata.
- Do not change scoring constants in `src/brawl/engine.ts` without updating the tests and the wiki page.
- Layout anchors in the recogniser are for 2560×1440; other 16:9 sizes scale. No fixtures exist for other
  resolutions.
- User docs live in the GitHub wiki; README is quickstart only. `plans/` is gitignored planner state.
- The game window is matched by exact title `Deadlock` (`electron/main.ts`, `electron/gameWindow.ts`), never
  by substring: the app's own window is "Deadlock Street Brawl Helper".
- `screenshots/` is gitignored reference material (full draft frames the user supplies); it is not a fixture
  directory and nothing in tests may depend on it.
- `scripts/win/frames/` is the tracked full-frame set for the Windows harness (two real draft screenshots +
  hand-measured `labels.json`), unlike `screenshots/` above which stays gitignored and untested-against.
- Component tests (anything rendering React, e.g. `<BrawlView/>`) live under `src/components/__tests__/`
  and run in `jsdom` via `vite.config.ts`'s `test.environmentMatchGlobs`; the rest of the suite (`src/brawl`,
  `electron`, `scripts`) stays on the default Node environment. Don't add a global jsdom environment.
- `OverlayState` (`src/brawl/draw.ts`) is the full contract between the control window and the Electron
  overlay: card reads, the re-roll flag/rect, and the `advice` panel data (names, not ids — the overlay has
  no item/ability catalog). Extend it there, not with ad hoc IPC payloads.
- koffi callback params (e.g. `EnumWindows`) need a real prototype via `koffi.proto(...)`, not a bare
  `'void *'` — the latter silently enumerates zero windows instead of throwing (see `electron/gameWindow.ts`).
- Never pass `detached: true` to `child_process.spawn('powershell.exe', ...)` on Windows: the child exits
  almost immediately (code 0, no window, no side effects) instead of running. Plain (non-detached) spawn
  blocks correctly; kill it explicitly instead of relying on OS-level detachment
  (see `scripts/win/e2e-main.cjs`).
- `.ps1` files must stay ASCII-only (no em dashes/curly quotes): Windows PowerShell 5.1's default script
  encoding mangles non-ASCII bytes into parser errors.
- `electron-dist/main.js` is built as ESM (package.json has `"type": "module"`); load it from a CommonJS
  script with dynamic `import(pathToFileURL(...).href)`, not `require()`.
- `electron/preload.ts` must build to CommonJS (`electron-dist/preload.cjs`, forced via a Vite lib build in
  `vite.config.ts`) — Electron's sandboxed preload loader rejects an ESM preload. Electron does emit a `preload-error` event for
  this, but nothing logged it before; `logPreloadErrors()` in `electron/main.ts` now logs it as
  `preload.error`. The visible symptom is `window.brawlAPI` staying `undefined`.
- Harness ordering: in `e2e-main.cjs`'s `frames` case, hero/round/choice are set **before** the fake window is
  spawned. Changing the Round/Choice selects clears the accepted cards and the worker never re-sends a set it
  already accepted, so setting them after capture starts leaves advice null for that frame.
- `fake-deadlock.ps1` scales its screenshot once into a 1280x720 bitmap (`BackgroundImage`); do not go back to
  scaling inside a PowerShell `Paint` handler (slow repaints left the window blank on screen).
- Under `BRAWL_E2E` both the control window and the overlay run at opacity 0 and the fake window sits at the
  bottom of the z-order, so a harness run never covers the person's other windows. The `frames` case saves
  what capture received to `logs/win-e2e-frame-<name>.png`.
- The harness never screen-grabs the desktop (`CopyFromScreen` etc.); only the window titled "Deadlock" may be
  captured, including by diagnostic scripts.
- `scripts/win/e2e-main.cjs`'s `waitFor(fn, timeoutMs)` resolves on the first **truthy** return of `fn()`.
  Polling for a numeric threshold (not just existence) needs the `> N` check done inside the callback, or it
  resolves on the first small-but-truthy value.
- PowerShell console output written from inside a WinForms event handler (e.g. `Add_Shown`), redirected
  through a pipe to a Node child process, is not reliably flushed per line by `Write-Output`/`Write-Host`.
  Use `[Console]::Out.WriteLine(...)` then `[Console]::Out.Flush()` (see `fake-deadlock.ps1`).
- `BrawlView.tsx` logs `capture.attempt` before every `getDisplayMedia` call (success or failure) and
  `capture.start` only after a successful attempt + `video.play()`. Anything that needs to observe denied
  attempts (e.g. e2e retry-loop checks) must count `capture.attempt`, not `capture.start`.
- The e2e fake window (`fake-deadlock.ps1`) and, under `BRAWL_E2E`, the control window
  (`electron/main.ts`) never steal focus or come to the front — `SW_SHOWNOACTIVATE`/`SetWindowPos(HWND_BOTTOM)`
  and `showInactive()` respectively. This doesn't affect capture: `desktopCapturer`/`getDisplayMedia` read a
  window's pixels by handle regardless of z-order or visibility.
- `scripts/win/frames/labels.json`'s `boxes` are frame px at the source PNGs' own 2000x1125 resolution, not
  at whatever resolution the fake window's capture ends up at. `fake-deadlock.ps1 -Image` stretches the PNG
  to fill the whole (16:9) client area, so the harness scales label boxes by `capturedFrameW / 2000` before
  comparing against `window.__overlayDrawn` (frame px in the _captured_ frame's own resolution) — see
  `runFramesCase` in `scripts/win/e2e-main.cjs`.
- `fake-deadlock.ps1`'s window is `FormBorderStyle = 'None'` (borderless): desktopCapturer/getDisplayMedia
  (Windows Graphics Capture) captures a window's _full bounds_ including title bar/border chrome, not just
  its client area. With a title bar, the captured frame came back non-16:9 (e.g. 1282x758 for a 1280x720
  client) and every fixed-layout anchor in the recogniser was silently offset — a real Deadlock window is
  presumably borderless already, so this was a harness-only artifact, not a real-world recogniser problem.
- Closing one fake-deadlock.ps1 window and opening the next (as the `frames` harness case does per labelled
  frame) invalidates the old window's WGC capture handle ("target source has been closed") and stops the
  video track. `BrawlView.tsx`'s game-rect effect retries `startCapture()` whenever the game window is
  present and `capture === 'off'`, regardless of `denied` (not just after a getDisplayMedia denial) — this
  covers that case too, since a stale-track stop never sets `denied`. Don't gate that retry on `denied`
  again; it was the root cause of a capture that never recovered after the first window swap.
- `video.srcObject`/`videoWidth` are not a reliable "is capture actually running" signal in the harness:
  `stopCapture()` never clears `srcObject`, so a dead, frozen `<video>` keeps reporting its last-known
  size forever. Poll a fresh `capture.attempt` console line count instead (see `waitForCaptureOn` /
  `captureStartTotal` in `scripts/win/e2e-main.cjs`).
- `drawReads` (`src/brawl/draw.ts`) returns the rects it actually stroked (`DrawnRect[]`, frame px, tagged
  `card`/`best`/`reroll`); `OverlayApp.tsx` stashes the latest list on `window.__overlayDrawn`, gated by
  `window.brawlAPI.isE2E` (from `electron/preload.ts`, `BRAWL_E2E=1`) so it's a no-op outside the harness.
- The e2e-only forced-reroll hook lives on `__brawlE2E.forceReroll()` in `electron/main.ts`: it resends the
  last real, capture-derived `OverlayState` with `reroll:true`/`bestId:null` — never a fabricated state —
  for PLAN.md item 3's `reroll-box` check when no frame naturally verdicts RE-ROLL.
- `scripts/win/e2e-main.cjs`'s hard timeout is 40s (`HARD_TIMEOUT_MS`); a hit cascades into spurious failures on
  whichever case runs last, so treat it as a real failure and speed the harness up rather than raising it.
- `win:demo`'s and `win:e2e`'s `testmode` case both must wait for a real ranked-best signal
  (`.brawl-card.best` in the control window / `.overlay-panel` text containing an actual card name), not
  just for _some_ status text to render — status text (hero/round/ability line) appears immediately, well
  before the worker's two-frame accept debounce (`worker.ts`) resolves cards into a ranked pick. Waiting on
  the earlier signal produces a real-looking but blank screenshot / a false pass on stale text.
- `webContents.capturePage()` flattens a `transparent: true` `BrowserWindow` to an opaque bitmap (no alpha),
  confirmed with `sharp` (`hasAlpha: false` on the output despite the window being transparent). To composite
  a transparent overlay's real content over another layer, read the overlay's own `<canvas>` element's
  `toDataURL('image/png')` instead (via `executeJavaScript`) — that's a real per-pixel-alpha rasterisation,
  not a window screenshot. See `captureTestComposite()` in `electron/main.ts`.
- Harness gotchas from test mode: a window with opacity < 1 is not offered to window capture at all, so the
  dummy stays opaque and is pushed to `HWND_BOTTOM` (`sendWindowToBottom` in `electron/gameWindow.ts`);
  `e2e-main.cjs`/`demo-main.cjs` also disable `CalculateNativeWinOcclusion` so a covered window keeps rendering.
  `desktopCapturer` can lag a newly found window by a moment, so `BrawlView` retries capture every 2 s while a
  game rect is known and capture is off. The `frames` case clears `localStorage` and reloads first (enemies/owned
  from earlier cases change scores), and reads drawn rects and overlay-panel scores in one call (two reads can
  straddle a state update). The fake window is 1920x1080: the recogniser cannot read the choice glyph at 1280x720.

## Detect now (F8) and the lobby status dot

- **Detect now** (F8 global hotkey, the `Detect now (F8)` button beside Start capture, tray entry) = `detectNow()` in
  `electron/main.ts`: clears the post-miss hold, forces `captureWanted`, and pushes `detect-run` to the control window,
  which treats the first worker result as the verdict (`runDetect`/`finishDetect` in `BrawlView.tsx`): draft -> normal
  path; not a draft -> status `No draft found`, capture off, `detect-miss` IPC (main holds capture off even in test
  mode/harness until the next press, window change or test-frame switch). Logs `detect.manual` (`hit|miss|failed`, ms).
  F8 is registered only while a game/dummy window exists (`electron/detectKey.ts`); a failed registration shows
  "F8 is in use by another program". e2e hooks: `__brawlE2E.detectNow()/forceCaptureOff()/getDot()/getF8()`.
- **Status dot**: drawn by the overlay (`drawDot` in `draw.ts`, `OverlayState.dot`, set by main, never by the control
  window) top-left, ~10 px at 1080p, 70 % opaque: teal watching / amber reading / grey capture failed. Shown per the
  pure state machine `src/brawl/lobbyDot.ts` (window found, no draft for 10 min or window lost/found = lobby; hidden
  while in a match or when Deadlock is not foreground; test mode/harness count as foreground). Hover line is
  `DOT_TEXT`; hit-tested in `OverlayApp.tsx`. `overlayHasContent` includes `dot`.
- Probe diagnostics: `draft.probe.miss` logs (on change only) `not-foreground` or `glyph-not-read`. A real miss cause
  found offline: at some widths (1312, 1600) a stray lit pixel from neighbouring UI stretched the CHOICE-1 glyph box;
  `readDigit` now retries ignoring one-pixel columns (`probe-scales.test.ts`).

## Performance design (keep the game fast)

- Capture is not on all session. `electron/main.ts` owns a capture state (`captureWanted`, `probeMode()`); the
  control window follows it via `getCaptureState`/`onCaptureState`. While the game is foreground and capture is
  off, main probes a tiny screen region (`electron/shopProbe.ts`, GDI `grabScreenRegion`) for the CHOICE glyph;
  a hit turns capture on. The renderer calls `captureIdle` after 4 s with no draft/tip. Probe mode is off under
  `BRAWL_E2E` and in test mode, so the harness never probes.
- Frames are region-only: `draftRegions` (`src/brawl/recognise.ts`) lists the rects the recogniser reads; the
  page copies just those and the worker pastes them into a reused buffer. `regions.test.ts` proves reads are
  identical to full frames. Do not reassign `canvas.width/height` per frame (reallocates); it cost ~100 ms.
- The worker persists across capture sessions (`reset`/`stop` messages); OCR is warmed on `init`/`reset`.
- Timing (`src/perf.ts`, `process.metrics`) runs only in dev (`DEV_SERVER_URL` / `import.meta.env.DEV`).
- Speed (advice latency): matching uses summed-area tables (`integralOf`/`sampleFast` in `recognise.ts`, exact same
  reads as `sampleSquare`, ~2x faster); the worker is built and its icon index decoded when the app opens; the hero bar
  read (~0.7 s) is reused for the whole match while a pixel fingerprint of the bar still matches (`matchBar` in
  `worker.ts`); the control and dummy windows set `backgroundThrottling: false` so covered windows keep rendering.
  `scripts/__tests__/frame-reads.test.ts` pins the reads on the demo frames so speed work cannot change advice. The worker reads only the player's own portrait and the enemy four (`readLeanBar`; the three teammates come back as unread slots, and `enemiesFrom`/`selfHero` never use them), and hero correlation skips masked-out pixels (`nccMasked`, bit-identical). The page draws the video once per frame into one canvas and cuts the regions from it (each `drawImage` from the video costs ~10 ms whatever its size, so per-region draws were ~70 ms); it copies a draft frame only when the video has presented a new picture since the last copy (`requestVideoFrameCallback`, 150 ms fallback), and the worker asks for the next frame as soon as it starts reading one, so the two-frame check finds it waiting.
- Main lowers its own and child priority below normal (skipped under `BRAWL_E2E`).
- Not verified on real Windows: GDI probe with a real Deadlock (borderless and fullscreen). Check by hand.
