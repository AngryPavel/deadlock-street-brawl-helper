import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
} from 'electron';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  findGameWindow,
  grabScreenRegion,
  isGameForeground,
  isGameWindowTitle,
  resizeWindowPhysical,
  sendWindowToBottom,
  type Rect,
} from './gameWindow';
import { probeShopScreen } from './shopProbe';
import { CHANNELS } from './channels';
import { MIN_HEIGHT, MIN_WIDTH, isBounds, validBounds } from './windowBounds';
import { overlayHasContent } from '../src/brawl/overlayContent';
import { dotState, initialLobby, lobbyDotVisible, stepLobby, type DotState } from '../src/brawl/lobbyDot';
import { shouldRegisterDetectKey } from './detectKey';

// Not imported from draw.ts (the recogniser): main only needs the blank shape.
const BLANK_OVERLAY = {
  reads: [],
  bestId: null,
  reroll: false,
  frameW: 0,
  frameH: 0,
  advice: null,
  draft: false,
  panel: null,
};
import { log } from '../src/log';
import { createPerf } from '../src/perf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const GAME_WINDOW_TITLE = 'Deadlock'; // exact match only (electron/gameWindow.ts#isGameWindowTitle):
// the app's own control window is titled "Deadlock Street Brawl Helper" and must never match.
// Dev only (the Vite dev server is running): timing/CPU summaries every 10 s. A packaged or built app has no dev
// server, records nothing and starts no timer.
const perf = createPerf(!!DEV_SERVER_URL, 'electron-main');
// The helper must never compete with the game for CPU: run below normal priority. Child processes (renderers, GPU)
// inherit this class on Windows, so it is set before any of them start; applied to the existing ones again once up.
if (!process.env.BRAWL_E2E) {
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    log('electron-main', 'warn', 'priority.fail', { message: String(err) });
  }
}
const RECT_POLL_MS = 250; // base tick; see the poll's own cadence below
// Game window lookup cadence (in ticks): once a second while no game is open, twice a second while it is.
const POLL_TICKS_NO_GAME = 4;
const POLL_TICKS_GAME = 2;

let control: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastRect: Rect | null = null;
// Whether the control window should be capturing the game (see CHANNELS.captureState). With a real game this stays
// false until `probeShopScreen` sees the draft screen, and goes back to false when the control window says the draft
// and its tip are over. Test mode and the e2e harness (`probe` false) capture whenever the game window exists.
let captureWanted = false;
let lastCaptureStateJson = '';
// Detect now: after a miss, capture stays off even where it normally just follows the window (test mode, harness),
// until the next press, a window change or a test-frame switch.
let captureHeld = false;
// The last capture start failed or was denied (grey dot).
let captureFailed = false;
// Lobby status dot (see src/brawl/lobbyDot.ts) and the F8 hotkey, which exists only while a game window does.
let lobby = initialLobby();
let lastDot: DotState | null = null;
let f8Registered = false;
let f8InUse = false;
const DETECT_KEY = 'F8';
const probeMode = () => process.platform === 'win32' && !process.env.BRAWL_E2E && !alive(testWindow);
function captureState() {
  return { wanted: captureWanted, probe: probeMode() };
}
function emitCaptureState() {
  const st = captureState();
  const json = JSON.stringify(st);
  if (json === lastCaptureStateJson) return;
  lastCaptureStateJson = json;
  log('electron-main', 'info', 'capture.state', st);
  sendControl(CHANNELS.captureState, st);
}
let pollTimer: ReturnType<typeof setInterval> | null = null;
// Mirrors the value passed to the last setIgnoreMouseEvents() call, so the e2e harness can assert the
// *actual* live click-through state instead of the literal `true` createOverlayWindow() happens to pass
// today (electron/main.ts has no BrowserWindow getter to read this back).
let overlayIgnoresMouseEvents = false;
// The overlay window is on screen only while there is something to draw (the item draft screen or the ability points panel)
// and the game window exists: a transparent always-on-top window over a running game is what costs the game frames,
// so outside those moments it is hidden, not merely blank. `overlayEnabled` is the tray / shortcut toggle.
let overlayWanted = false;
let overlayEnabled = true;
// Last OverlayState relayed to the overlay window, kept only so the e2e harness's forceReroll() hook can
// resend a reroll:true clone of it -- real capture-derived reads, not a fabricated OverlayState -- for
// PLAN.md's item 3 forced reroll-box pass (both tracked frames' actual engine verdict is TAKE, so a natural
// RE-ROLL never occurs in the frames harness case). Unused outside BRAWL_E2E.
let lastOverlayState: import('../src/brawl/draw').OverlayState | null = null;
// Test mode: an app-owned dummy game window, titled exactly "Deadlock" so the normal find/capture/recognise/
// advise/overlay path treats it as the game, showing one of the shipped draft screenshots. It only ever starts
// when no real "Deadlock" window is open, and the display-media handler serves only this window's own source id
// while it is on, so test mode can never capture anything else.
let testWindow: BrowserWindow | null = null;
let testFrame = 'choice1';
let testMessage: string | null = null;
// Under BRAWL_E2E the harness must stay invisible to the person: the control window and overlay run at opacity 0,
// and the test-mode dummy stays fully opaque (a window with opacity < 1 is never offered to window capture) but
// is sent to the bottom of the z-order and shown without activating it. A person using test mode sees the
// dummy normally.

const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed();

/** Send to the control window if it still exists (it can be gone during shutdown). */
function sendControl(channel: string, ...args: unknown[]) {
  if (alive(control) && !control.webContents.isDestroyed()) control.webContents.send(channel, ...args);
}

/** Directory of shipped draft screenshots: `public/demo/` in dev (relative to this file, same convention as
 *  the tray icon below), `dist/demo/` inside the asar once packaged (Vite copies `public/` into `dist/`). */
function demoDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'demo')
    : path.join(__dirname, '../public/demo');
}
const demoImagePath = (name: string) => path.join(demoDir(), `${name}.png`);

/** Every draft screenshot test mode can show, by name (file name without .png), sorted. */
function testFrames(): string[] {
  try {
    return readdirSync(demoDir())
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}

// Electron's own setDisplayMediaRequestHandler implementation throws "Video was requested, but no video
// stream was provided" as an unhandled rejection *inside Electron*, not something our handler's try/catch
// can reach, whenever the request asked for video (it always does here) and we deny by calling callback({})
// with none — this is Electron's documented-by-behavior way of surfacing a denial, confirmed against
// Electron 33's actual runtime (not just its .d.ts, which allows callback({}) but doesn't say what happens
// next). Left unhandled, Node just warns by default, but log it instead of leaving a scary, unexplained
// trace on every deny so it doesn't look like a crash.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (err.message === 'Video was requested, but no video stream was provided') {
    log('electron-main', 'debug', 'capture.deny.artifact', { message: err.message });
    return;
  }
  log('electron-main', 'error', 'unhandled.rejection', { message: err.message, stack: err.stack });
});

function loadRoute(win: BrowserWindow, route: string) {
  if (DEV_SERVER_URL) win.loadURL(`${DEV_SERVER_URL}${route}`);
  else win.loadFile(path.join(__dirname, '../dist/index.html'), { hash: route.replace(/^#/, '') });
}

/** Logs a preload load failure instead of leaving `window.brawlAPI` silently undefined (the symptom
 *  a bad preload build — e.g. emitted as ESM — produces with no other visible error). */
function logPreloadErrors(win: BrowserWindow) {
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('electron-main', 'error', 'preload.error', { preloadPath, message: error.message, stack: error.stack });
  });
}

const WINDOW_BG = '#101314'; // charcoal: the window's colour before the page paints, so there is no white flash
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadSavedBounds(): Electron.Rectangle {
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  let saved: unknown = null;
  if (!process.env.BRAWL_E2E) {
    try {
      saved = JSON.parse(readFileSync(stateFile(), 'utf8'));
    } catch {
      /* first launch or unreadable: use the default */
    }
  }
  return validBounds(saved, displays, screen.getPrimaryDisplay().workArea);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Remembers the control window's size and position (debounced). Not while test mode has it parked beside the dummy. */
function scheduleSaveBounds() {
  if (process.env.BRAWL_E2E || controlBoundsBeforeTest) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!alive(control) || control.isMinimized() || controlBoundsBeforeTest) return;
    const b = control.getNormalBounds();
    if (isBounds(b)) {
      try {
        writeFileSync(stateFile(), JSON.stringify(b));
      } catch (err) {
        log('electron-main', 'warn', 'window.state.save.fail', { message: String(err) });
      }
    }
  }, 500);
}

function createControlWindow() {
  control = new BrowserWindow({
    ...loadSavedBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false, // the page draws its own title strip (src/components/TitleBar.tsx); no Windows title bar or menu
    backgroundColor: WINDOW_BG,
    title: 'Deadlock Street Brawl Helper',
    show: !process.env.BRAWL_E2E,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // the capture loop runs here while the game is in front of this window
    },
  });
  control.setMenuBarVisibility(false);
  control.removeMenu();
  control.on('resize', scheduleSaveBounds);
  control.on('move', scheduleSaveBounds);
  // A drag must only move the window: if the system changes its size mid-drag (display scaling rounding), put it back.
  let dragSize: [number, number] | null = null;
  control.on('will-move', () => {
    dragSize ??= control!.getSize() as [number, number];
  });
  control.on('moved', () => {
    if (dragSize && alive(control)) {
      const [w, h] = control.getSize();
      if (w !== dragSize[0] || h !== dragSize[1]) {
        log('electron-main', 'warn', 'window.drag.resized', { before: dragSize, after: [w, h] });
        control.setSize(dragSize[0], dragSize[1]);
      }
    }
    dragSize = null;
  });
  logPreloadErrors(control);
  if (process.env.BRAWL_E2E) {
    // Under the e2e/demo harness, this window is driven entirely via executeJavaScript, never actually
    // looked at by a person -- setOpacity(0) keeps it fully composited (real paint, real content) while
    // making it 100% invisible regardless of its z-order, instead of trying to keep it out of the way via
    // position or z-order (see the comment above DEMO_MS for why those don't work here).
    control.once('ready-to-show', () => {
      control?.setOpacity(0);
      control?.showInactive();
    });
  }
  loadRoute(control, '#/');
  control.on('closed', () => {
    control = null;
    app.quit();
  });
}

function createOverlayWindow() {
  overlay = new BrowserWindow({
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  logPreloadErrors(overlay);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlayIgnoresMouseEvents = true;
  overlay.setAlwaysOnTop(true, 'screen-saver');
  // Under the harness nobody looks at the overlay (checks read it via capturePage/executeJavaScript), and it
  // is always-on-top: left visible it would draw over whatever the person is working in. Same opacity-0
  // approach as the control window above.
  if (process.env.BRAWL_E2E) overlay.setOpacity(0);
  loadRoute(overlay, '#/overlay');
  overlay.on('closed', () => {
    overlay = null;
  });
}

/** Snaps a physical-pixel screen rect to the DIPs `setBounds` expects on the display it's on. */
function toDipBounds(rect: Rect) {
  const display = screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const scale = display.scaleFactor || 1;
  return {
    x: Math.round(rect.x / scale),
    y: Math.round(rect.y / scale),
    width: Math.round(rect.width / scale),
    height: Math.round(rect.height / scale),
  };
}

function rectsEqual(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Native window handles for this app's own windows (except the test-mode dummy, which stands in for the game), so findGameWindow can never latch onto them even if
 *  a title match somehow slipped through. */
function ownWindowHandles(includeTest = false): Set<bigint> {
  const handles = new Set<bigint>();
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === testWindow && !includeTest) continue; // the dummy game window must be findable as the game
    try {
      handles.add(w.getNativeWindowHandle().readBigUInt64LE());
    } catch {
      /* not on win32, or window already destroyed */
    }
  }
  return handles;
}

function currentDot(): DotState | null {
  const fg = !probeMode() || isGameForeground();
  if (!lobbyDotVisible(lobby, fg)) return null;
  return dotState({ captureFailed, capturing: captureWanted || !!lastOverlayState?.draft });
}
/** Sends the overlay the control window's last state plus the dot (which only the main process knows). */
function relayOverlay() {
  const state = { ...(lastOverlayState ?? BLANK_OVERLAY), dot: lastDot };
  overlayWanted = overlayHasContent(state);
  syncOverlay();
  if (alive(overlay) && !overlay.webContents.isDestroyed()) overlay.webContents.send(CHANNELS.overlayState, state);
}
/** Recomputes the dot; resends the overlay state only when it changed. */
function refreshDot() {
  const d = currentDot();
  if (d === lastDot) return;
  lastDot = d;
  relayOverlay();
}

// Probe diagnostics (requirement: why automatic detection misses): one line whenever the reason the probe is not
// hitting changes, never per tick. Reasons: not foreground, screen grab failed, glyph not read.
let lastProbeFact = '';
function logProbeMiss(foreground: boolean) {
  const fact = foreground ? 'glyph-not-read' : 'not-foreground';
  if (fact === lastProbeFact) return;
  lastProbeFact = fact;
  log('electron-main', 'info', 'draft.probe.miss', { reason: fact });
}

function syncDetectKey(gameExists: boolean) {
  const act = shouldRegisterDetectKey(gameExists, f8Registered);
  if (act === 'register') {
    f8Registered = globalShortcut.register(DETECT_KEY, () => detectNow('f8'));
    f8InUse = !f8Registered;
    log('electron-main', f8Registered ? 'info' : 'warn', f8Registered ? 'detect.key.registered' : 'detect.key.in-use');
    sendControl(CHANNELS.detectKeyState, f8InUse);
  } else if (act === 'unregister') {
    globalShortcut.unregister(DETECT_KEY);
    f8Registered = false;
    f8InUse = false;
    sendControl(CHANNELS.detectKeyState, false);
  } else if (gameExists && !f8Registered && f8InUse === false) {
    /* unreachable: register always sets one of the two */
  }
}

/** Detect now (F8, button, tray): capture of the game on at once (bypassing the screen probe and the foreground
 *  check); the control window reads the first frame and reports hit or miss. Returns false without a game window. */
function detectNow(source: string): boolean {
  if (!lastRect) return false;
  log('electron-main', 'info', 'detect.request', { source });
  captureHeld = false;
  captureWanted = true;
  emitCaptureState();
  refreshDot();
  sendControl(CHANNELS.detectRun, source);
  return true;
}

/** Shows or hides the overlay window to match `overlayWanted`, the game window and the toggle. */
function syncOverlay() {
  if (!alive(overlay)) return;
  const rect = lastRect;
  const show = !!rect && (overlayWanted || lastDot !== null) && overlayEnabled;
  if (rect && show && !overlay.isVisible()) {
    overlay.setBounds(toDipBounds(rect));
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  } else if (!show && overlay.isVisible()) {
    overlay.hide();
  }
}

// How often the overlay is pushed back on top of the game while it is showing. It is also re-asserted at once when it
// is shown, when the game window moves, and when the game becomes the foreground window again.
const OVERLAY_REASSERT_MS = 2000;

function startRectPolling() {
  if (pollTimer) return;
  let tickNo = 0;
  let lastReassert = 0;
  let gameWasForeground = false;
  pollTimer = setInterval(() => {
    tickNo += 1;
    if (tickNo % (lastRect ? POLL_TICKS_GAME : POLL_TICKS_NO_GAME) !== 0) return;
    const t0 = performance.now();
    if (alive(testWindow) && findGameWindow(GAME_WINDOW_TITLE, ownWindowHandles(true))) {
      // A real Deadlock window appeared while test mode was on: hand over to the real game.
      stopTestMode('A real Deadlock window opened, so test mode was turned off.');
    }
    const found = findGameWindow(GAME_WINDOW_TITLE, ownWindowHandles());
    let reassert = false;
    if (!rectsEqual(found, lastRect)) {
      lastRect = found;
      log('electron-main', 'info', found ? 'window.found' : 'window.lost', found ?? undefined);
      sendControl(CHANNELS.gameRect, found);
      if (found && alive(overlay)) overlay.setBounds(toDipBounds(found));
      syncOverlay();
      reassert = true;
      captureFailed = false;
      captureHeld = false;
    }
    syncDetectKey(!!found);
    lobby = stepLobby(lobby, { type: 'tick', found: !!found, now: Date.now() });
    refreshDot();
    // Real game: capture stays off until the draft screen shows up. Only sample the screen while the game is the
    // foreground window (so pixels of some other window covering it are never read), and only a few hundred pixels.
    if (!found) {
      captureWanted = false;
      captureHeld = false;
    } else if (!probeMode()) captureWanted = !captureHeld;
    else if (!captureWanted && isGameForeground()) {
      const hit = perf.time('probe', () => probeShopScreen(found, grabScreenRegion));
      if (hit) {
        captureWanted = true;
        log('electron-main', 'info', 'draft.probe.hit');
      }
    }
    if (found && probeMode() && !captureWanted) logProbeMiss(isGameForeground());
    emitCaptureState();
    // The game re-focusing (e.g. after an alt-tab elsewhere, or a fullscreen toast) can cover the overlay even though
    // it's marked always-on-top, so push it back on top -- when the game regains the foreground and otherwise every
    // couple of seconds, not on every tick.
    if (found && alive(overlay) && overlay.isVisible()) {
      const fg = isGameForeground();
      const now = Date.now();
      if (reassert || (fg && !gameWasForeground) || now - lastReassert >= OVERLAY_REASSERT_MS) {
        overlay.setAlwaysOnTop(true, 'screen-saver');
        overlay.moveTop();
        lastReassert = now;
      }
      gameWasForeground = fg;
    } else gameWasForeground = false;
    perf.record('poll.tick', performance.now() - t0);
  }, RECT_POLL_MS);
}

/** Dev only: CPU and memory of every Electron process, summarised with the other timings. */
function startProcessMetrics() {
  if (!perf.enabled) return;
  const t = setInterval(() => {
    const procs = app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
      memoryMB: Math.round(m.memory.workingSetSize / 1024),
    }));
    const total = Math.round(procs.reduce((a, p) => a + p.cpuPercent, 0) * 10) / 10;
    log('electron-main', 'info', 'process.metrics', { totalCpuPercent: total, processes: procs });
  }, 10_000);
  t.unref();
}

/** Below-normal priority for every process this app has running (see the top of the file). */
function lowerAllPriorities() {
  if (process.env.BRAWL_E2E) return;
  for (const m of app.getAppMetrics()) {
    try {
      os.setPriority(m.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* already gone */
    }
  }
}

function testState() {
  return { on: alive(testWindow), frame: testFrame, frames: testFrames(), message: testMessage };
}
function broadcastTestState() {
  sendControl(CHANNELS.testModeState, testState());
}

/** (Re)creates the overlay window if it was closed, so test mode and the shortcut keep working after the
 *  person closes it. */
function ensureOverlay() {
  if (!alive(overlay)) createOverlayWindow();
}

/** Points the dummy window at a draft screenshot and resolves once the image has decoded. */
async function showTestFrame(win: BrowserWindow, frame: string): Promise<boolean> {
  const url = pathToFileURL(demoImagePath(frame)).href;
  try {
    return await win.webContents.executeJavaScript(
      `(async () => { const i = document.getElementById('shot'); i.src = ${JSON.stringify(url)};
        try { await i.decode(); } catch { return false; } return i.naturalWidth > 0; })()`,
    );
  } catch (err) {
    log('electron-main', 'warn', 'testmode.frame.fail', { frame, message: String(err) });
    return false;
  }
}

let controlBoundsBeforeTest: Electron.Rectangle | null = null;

/** Test mode on a real desktop: the dummy game window goes to the left edge of the work area and the control window
 *  fills what is left on the right, so both can be seen at once (the overlay follows the dummy on its own). */
function arrangeSideBySide(dummy: BrowserWindow) {
  const wa = screen.getDisplayMatching(dummy.getBounds()).workArea;
  dummy.setPosition(wa.x, wa.y);
  if (!alive(control)) return;
  const dw = dummy.getBounds().width;
  if (!controlBoundsBeforeTest) controlBoundsBeforeTest = control.getBounds();
  if (control.isMaximized() || control.isMinimized()) control.restore();
  control.setBounds({ x: wa.x + dw, y: wa.y, width: Math.max(360, wa.width - dw), height: wa.height });
}

/** Turns test mode on: opens a visible dummy game window (titled exactly "Deadlock", borderless, 16:9, showing
 *  a real draft screenshot) that the normal capture path then finds and reads like the real game. Refuses --
 *  without touching anything -- when a real "Deadlock" window is already open. */
async function startTestMode(frame?: string) {
  if (alive(testWindow)) return testState();
  if (findGameWindow(GAME_WINDOW_TITLE, ownWindowHandles(true))) {
    testMessage = 'Test mode did not start: a real Deadlock window is open. Close Deadlock first.';
    log('electron-main', 'info', 'testmode.refused-game-open');
    broadcastTestState();
    return testState();
  }
  testMessage = null;
  const frames = testFrames();
  if (frame && frames.includes(frame)) testFrame = frame;
  else if (!frames.includes(testFrame)) testFrame = frames[0] ?? testFrame;
  ensureOverlay();
  // 1920x1080 *physical* px whatever the display scaling: the recogniser needs roughly 1080p to read the
  // round/choice glyphs, like a real game window.
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const win = new BrowserWindow({
    width: Math.round(1920 / sf),
    height: Math.round(1080 / sf),
    useContentSize: true,
    frame: false, // borderless like the game: window capture includes any chrome, which would skew the layout
    resizable: false,
    show: false,
    title: GAME_WINDOW_TITLE,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  testWindow = win;
  win.on('page-title-updated', (e) => e.preventDefault()); // keep the exact game title
  win.on('closed', () => {
    if (testWindow === win) testWindow = null;
    broadcastTestState();
  });
  // A real file:// page (not a data: URL): the screenshots are >1MB, past what data: URLs load reliably.
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;overflow:hidden;background:#000">
    <img id="shot" style="width:100vw;height:100vh;object-fit:fill;display:block" /></body></html>`;
  const tmpHtmlPath = path.join(app.getPath('temp'), 'brawl-test-mode.html');
  writeFileSync(tmpHtmlPath, html);
  await win.loadFile(tmpHtmlPath);
  const decoded = await showTestFrame(win, testFrame);
  if (!alive(win)) return testState();
  win.setTitle(GAME_WINDOW_TITLE);
  win.showInactive();
  if (Math.round(win.getContentBounds().width * sf) < 1920)
    resizeWindowPhysical(win.getNativeWindowHandle(), 1920, 1080);
  // Harness only: a transparent (opacity < 1) window is not offered by window capture at all, so the dummy is
  // fully opaque but pushed to the bottom of the z-order so it never covers the person's other windows.
  if (process.env.BRAWL_E2E) sendWindowToBottom(win.getNativeWindowHandle());
  else arrangeSideBySide(win);
  log('electron-main', 'info', 'testmode.start', { frame: testFrame, decoded, bounds: win.getBounds() });
  broadcastTestState();
  return testState();
}

/** Turns test mode off: closes the dummy window (and only that) and hides the overlay it was driving. */
function stopTestMode(message: string | null = null) {
  const win = testWindow;
  testWindow = null;
  testMessage = message;
  if (alive(win)) win.close();
  if (controlBoundsBeforeTest && alive(control)) control.setBounds(controlBoundsBeforeTest);
  controlBoundsBeforeTest = null;
  lobby = initialLobby();
  captureHeld = false;
  refreshDot();
  if (alive(overlay) && !lastRect) overlay.hide();
  log('electron-main', 'info', 'testmode.stop');
  broadcastTestState();
  return testState();
}

async function setTestFrame(frame: string) {
  if (!alive(testWindow) || !testFrames().includes(frame)) return testState();
  testFrame = frame;
  captureHeld = false;
  await showTestFrame(testWindow, frame);
  log('electron-main', 'info', 'testmode.frame', { frame });
  broadcastTestState();
  return testState();
}

/** Composites the test-mode dummy window and overlay windows' own rendered pixels into one PNG, via
 *  webContents.capturePage() -- Electron's internal compositor output -- rather than an OS-level screen
 *  copy. Needed because the demo windows are deliberately opacity-0 (see the comment above alive()) so
 *  they never visibly cover the user's other work; an OS-level screenshot of that screen region would just
 *  show whatever's really behind them, but capturePage() reads each window's own buffer directly regardless
 *  of opacity or z-order, so it still proves the real recognise -> advise -> draw pipeline drew boxes.
 *  Composited via a throwaway <canvas> in the control window's own renderer (drawImage layers backdrop then
 *  the transparent overlay on top, preserving overlay alpha) since there's no Node-side image compositor
 *  available here. Returns null if test mode isn't currently running. */
async function captureTestComposite(): Promise<Buffer | null> {
  if (!alive(testWindow) || !alive(overlay) || !alive(control)) return null;
  const backdrop = testWindow;
  const ov = overlay;
  // Chromium suspends compositing an opacity-0 window (same as an occluded or offscreen one -- see the
  // comment above DEMO_MS), so capturePage() right after setOpacity(0) is set can return a stale/blank
  // frame from before it went invisible. Flip to visible just long enough to force one real frame (two
  // rAF callbacks guarantees a compositor frame actually landed, not just a script tick), capture, then
  // immediately flip back -- the visible window exists for at most a couple of frames (~30ms), not the
  // whole demo, so it reads as a capture artifact rather than something blocking the user's screen.
  backdrop.setOpacity(1);
  const forceFrame = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
  await backdrop.webContents.executeJavaScript(forceFrame);
  const bgImage = await backdrop.webContents.capturePage();
  backdrop.setOpacity(0);
  const bgDataUrl = bgImage.toDataURL();
  // NOT ov.webContents.capturePage(): Electron's capturePage() flattens a transparent BrowserWindow to an
  // opaque RGB bitmap (confirmed via sharp: hasAlpha=false on the captured PNG even though the window is
  // `transparent: true`), so drawing that over the backdrop blotted out the whole draft screen with solid
  // near-black everywhere the overlay wasn't drawing a box. The overlay's own <canvas> element's own
  // toDataURL() is a real canvas rasterisation, not a window screenshot, so it keeps its real per-pixel
  // alpha -- only the stroked boxes/TAKE/RE-ROLL text are opaque, everywhere else is truly transparent.
  const fgDataUrl: string = await ov.webContents.executeJavaScript(
    "document.querySelector('canvas')?.toDataURL('image/png') ?? ''",
  );
  const composedDataUrl: string = await control.webContents.executeJavaScript(`
    (function () {
      return new Promise((resolve, reject) => {
        const bg = new Image();
        const fg = new Image();
        let loaded = 0;
        function onLoad() {
          loaded += 1;
          if (loaded < 2) return;
          const canvas = document.createElement('canvas');
          canvas.width = bg.naturalWidth;
          canvas.height = bg.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
          ctx.drawImage(fg, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        }
        bg.onerror = fg.onerror = () => reject(new Error('demo composite image failed to load'));
        bg.onload = onLoad;
        fg.onload = onLoad;
        bg.src = ${JSON.stringify(bgDataUrl)};
        fg.src = ${JSON.stringify(fgDataUrl)};
      });
    })()
  `);
  const base64 = composedDataUrl.slice(composedDataUrl.indexOf(',') + 1);
  return Buffer.from(base64, 'base64');
}

function setupDisplayMediaHandler() {
  // Serves the Deadlock window directly to getDisplayMedia in the renderer, so no picker dialog appears.
  // Never fall back to the first source in the list: capturing an arbitrary window when Deadlock isn't
  // running would silently show advice for whatever happened to be first instead of telling the user
  // the game isn't open.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      // In test mode only the dummy's own source qualifies, so nothing else can ever be captured. The app's own
      // windows are never listed by desktopCapturer, so the dummy is served by its media-source id directly.
      if (alive(testWindow)) {
        const id = testWindow.getMediaSourceId();
        log('electron-main', 'info', 'capture.chosen', { name: 'Deadlock (test dummy)' });
        callback({ video: { id, name: GAME_WINDOW_TITLE } as Electron.DesktopCapturerSource });
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ['window'] });
      const ownIds = new Set(
        [alive(control) ? control.getMediaSourceId() : null, alive(overlay) ? overlay.getMediaSourceId() : null].filter(
          Boolean,
        ),
      );
      const match = sources.find((s) => !ownIds.has(s.id) && isGameWindowTitle(s.name, GAME_WINDOW_TITLE));
      log('electron-main', match ? 'info' : 'warn', match ? 'capture.chosen' : 'capture.denied', { name: match?.name });
      if (!match) {
        captureFailed = true;
        refreshDot();
        sendControl(CHANNELS.captureDenied);
        callback({}); // denies the request instead of falling back to an arbitrary window
        return;
      }
      callback({ video: match });
    },
    { useSystemPicker: false },
  );
}

/** Only real Windows electron.exe can find the game window or capture it (koffi's win32 calls and
 *  desktopCapturer's window matching both no-op elsewhere) — `npm run dev:electron` run inside WSL boots
 *  Linux Electron under WSLg instead, so warn loudly rather than let capture silently never find anything.
 *  `npm run win:dev` is what actually runs Windows Electron from WSL. */
function platformWarning(): string | null {
  if (process.platform === 'win32') return null;
  const msg = `platform.unsupported: process.platform=${process.platform} — run "npm run win:dev" from WSL (or "npm run dev:electron" from a Windows terminal in the synced Windows copy), not dev:electron inside WSL`;
  log('electron-main', 'warn', 'platform.unsupported', { platform: process.platform });
  return msg;
}

function setupIpc() {
  ipcMain.handle(CHANNELS.getGameRect, () => lastRect);
  ipcMain.handle(CHANNELS.captureStateGet, () => captureState());
  ipcMain.on(CHANNELS.captureIdle, () => {
    if (!probeMode()) return; // test mode / harness: capture just follows the window
    captureWanted = false;
    emitCaptureState();
  });
  ipcMain.handle(CHANNELS.detectNow, () => detectNow('button'));
  ipcMain.handle(CHANNELS.detectKeyGet, () => f8InUse);
  ipcMain.on(CHANNELS.detectMiss, () => {
    captureWanted = false;
    captureHeld = true;
    emitCaptureState();
    refreshDot();
  });
  ipcMain.on(CHANNELS.captureResult, (_e, ok: boolean) => {
    captureFailed = !ok;
    refreshDot();
  });
  ipcMain.on(CHANNELS.windowMinimize, () => alive(control) && control.minimize());
  ipcMain.on(CHANNELS.windowClose, () => alive(control) && control.close());
  ipcMain.handle(CHANNELS.platformWarning, () => platformWarning());
  ipcMain.handle(CHANNELS.testModeGet, () => testState());
  ipcMain.handle(CHANNELS.testModeSet, (_e, on: boolean) => (on ? startTestMode() : stopTestMode()));
  ipcMain.handle(CHANNELS.testModeFrame, (_e, frame: string) => setTestFrame(String(frame)));
  // Relay: the control window computes advice from its capture and forwards state for the overlay to draw.
  ipcMain.on(CHANNELS.overlayState, (_event, state) => {
    lastOverlayState = state;
    if (state.draft) lobby = stepLobby(lobby, { type: 'draft', now: Date.now() });
    lastDot = currentDot();
    relayOverlay();
  });
}

function setupTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'apple-touch-icon.png')
    : path.join(__dirname, '../public/apple-touch-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Deadlock Street Brawl Helper');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Toggle overlay', click: toggleOverlay },
      { label: 'Detect now (F8)', click: () => detectNow('tray') },
      { label: 'Debug panel', click: toggleDebugPanel },
      { label: 'Toggle test mode', click: () => (alive(testWindow) ? stopTestMode() : void startTestMode()) },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function toggleDebugPanel() {
  if (alive(control) && !control.webContents.isDestroyed()) control.webContents.send(CHANNELS.debugToggle);
}

function toggleOverlay() {
  overlayEnabled = !overlayEnabled;
  syncOverlay();
}

// The demo backdrop window (triggerOverlayDemo) renders correctly inside Electron itself -- confirmed via
// webContents.capturePage(), which reads Electron's own compositor output -- but never actually reaches the
// physical screen: an OS-level screenshot (CopyFromScreen) and the user's own eyes both see solid black.
// The real "Deadlock" capture path never showed this because desktopCapturer/getUserMedia read frames
// straight from the GPU surface, bypassing DWM's window-to-screen composition entirely; this demo window has
// no such bypass and depends on that composition actually reaching the monitor, which fails in this
// environment (RDP/virtual-display sessions are a documented case where Chromium's GPU-accelerated surfaces
// never get composited to the real screen by DWM). Forcing software rendering (no GPU process) makes Chromium
// paint through the normal software/GDI path instead, which DWM does composite correctly.
// Only scoped to BRAWL_E2E (demo/e2e harness) runs, never a real game session: disabling hardware
// acceleration forces every window, including the real overlay, onto software/GDI rendering, which (a)
// is CPU-heavy enough to visibly lag a running game and (b) composites through DWM differently than the
// game's GPU flip-model surface, letting the game win the always-on-top fight and cover the overlay. The
// demo backdrop is the only window that actually needs this (see the comment above), and only when DWM
// isn't compositing GPU surfaces to the real screen (RDP/virtual-display sessions) -- real hardware runs
// must keep GPU acceleration on.
// scripts/win/demo-main.cjs and e2e-main.cjs both await app.whenReady() themselves before dynamically
// importing this module (so they can guard/instrument first), so app is already ready by the time this
// line runs under those harnesses -- disableHardwareAcceleration() throws in that case; it's a no-op we
// can safely skip since the harness process is short-lived and re-launched per run anyway.
if (process.env.BRAWL_E2E && !app.isReady()) app.disableHardwareAcceleration();

// Windows Graphics Capture draws a yellow border around whatever window it captures (Chromium does not ask for the
// borderless capture access that would remove it). Chromium's older GDI window capturer has no border, so switch the
// WGC window capturer off: the game window is read without any outline. The harnesses (which are already `ready`
// when this module loads) pass the same switch themselves; keep the two in sync (scripts/win/*-main.cjs).
if (!app.isReady()) app.commandLine.appendSwitch('disable-features', 'AllowWgcWindowCapturer');

app.whenReady().then(() => {
  setupDisplayMediaHandler();
  setupIpc();
  createControlWindow();
  createOverlayWindow();
  setupTray();
  startRectPolling();
  startProcessMetrics();
  setTimeout(lowerAllPriorities, 3000).unref();
  // Dev only: surface the control window's own perf summaries (a production build never emits them).
  if (perf.enabled && alive(control))
    control.webContents.on('console-message', (_e, _level, message) => {
      if (message.includes('"msg":"perf"')) console.info(message);
    });
  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay);
  // Test-only hook: scripts/win/e2e-main.cjs requires this exact module (not a stub) so it needs a way to
  // reach the real windows/handlers it just created. Inert unless BRAWL_E2E is set.
  if (process.env.BRAWL_E2E) {
    (globalThis as Record<string, unknown>).__brawlE2E = {
      getControl: () => control,
      toggleDebugFromTray: toggleDebugPanel,
      getOverlay: () => overlay,
      get overlayIgnoresMouseEvents() {
        return overlayIgnoresMouseEvents;
      },
      // Forces a reroll:true resend of the *real*, capture-derived last OverlayState -- for PLAN.md item
      // 3's forced reroll-box check when no frame's natural engine verdict is RE-ROLL. Returns false (no
      // send) if no real state has been relayed yet.
      forceReroll: () => {
        if (!lastOverlayState) return false;
        if (alive(overlay))
          overlay.webContents.send(CHANNELS.overlayState, { ...lastOverlayState, reroll: true, bestId: null });
        return true;
      },
      getTestWindow: () => testWindow,
      // Same code path as F8 / the button. forceCaptureOff() gives the "capture forced off" start state.
      detectNow: () => detectNow('e2e'),
      forceCaptureOff: () => {
        captureWanted = false;
        captureHeld = true;
        emitCaptureState();
      },
      getDot: () => lastDot,
      getF8: () => ({ registered: f8Registered, inUse: f8InUse }),
      captureTestComposite,
    };
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (pollTimer) clearInterval(pollTimer);
});
