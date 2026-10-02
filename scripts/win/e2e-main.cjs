// Windows-only Electron test harness. Run by real electron.exe (never Linux Electron): sets BRAWL_E2E=1,
// requires the REAL electron-dist/main.js (not a stub), drives it via executeJavaScript, and writes one
// JSON report. Filter cases with --only <name1,name2,...>. Everything runs against the app's own Test mode
// dummy window (no fake-deadlock.ps1 window is opened). Hard timeout 60s; a full run
// takes ~25 s. The ability panel lasts TIP_MS here (BRAWL_TIP_MS, 1.2 s) instead of the real 15 s.
'use strict';
process.env.BRAWL_E2E = '1';
const TIP_MS = 1200;
process.env.BRAWL_TIP_MS = String(TIP_MS);
const HARD_TIMEOUT_MS = 40_000;

const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const { app } = require('electron');
// A dummy window sitting under other windows must keep rendering (and being capturable): no occlusion throttling.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,AllowWgcWindowCapturer');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const ROOT = path.join(__dirname, '..', '..');
const FAKE_PS1 = path.join(__dirname, 'fake-deadlock.ps1');
const REPORT_PATH = path.join(ROOT, 'logs', 'win-e2e.json');

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null;

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? null });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function wantsCase(name) {
  return !only || only.includes(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runPs(args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FAKE_PS1, ...args], {
    windowsHide: false,
  });
}

const DEBUG_LOG = path.join(ROOT, 'logs', 'win-e2e-debug.log');
try {
  fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
  fs.writeFileSync(DEBUG_LOG, `${new Date().toISOString()} --- run start ---\n`);
} catch {
  /* best effort */
}
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* best effort */
  }
  process.stdout.write(msg + '\n'); // not console.log: console.log is wrapped below to call dbg()
}

let fakeProc = null;
let fakeWindowRect = null; // { pid, client:{x,y,width,height}, window:{...} } parsed from fake-deadlock.ps1's stdout
function startFakeWindow(args = []) {
  stopFakeWindow();
  fakeWindowRect = null;
  dbg(`spawning fake-deadlock.ps1: ${FAKE_PS1} exists=${fs.existsSync(FAKE_PS1)}`);
  // NOTE: detached:true here made the child exit almost instantly on Windows (code 0, no window,
  // no pidfile written) instead of blocking in Application.Run — verified by isolating the spawn
  // outside Electron entirely. Non-detached works correctly; we kill it explicitly via -Stop in
  // stopFakeWindow()/finish(), so we don't need OS-level detachment.
  fakeProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', FAKE_PS1, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  dbg(`fake-deadlock pid=${fakeProc.pid}`);
  fakeProc.stdout?.on('data', (d) => {
    const text = d.toString();
    dbg('fake-deadlock stdout: ' + text);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        fakeWindowRect = JSON.parse(trimmed);
      } catch {
        /* not our JSON line */
      }
    }
  });
  fakeProc.stderr?.on('data', (d) => dbg('fake-deadlock stderr: ' + d.toString()));
  fakeProc.on('error', (e) => dbg('fake-deadlock spawn error: ' + e.message));
  fakeProc.on('exit', (code, sig) => dbg(`fake-deadlock exited code=${code} sig=${sig}`));
}
function stopFakeWindow() {
  runPs(['-Stop']);
  fakeProc = null;
}

async function waitFor(fn, timeoutMs, stepMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// main.ts's own unhandledRejection handler filters exactly one known Electron artifact to debug and logs
// everything else via src/log.ts's console.error(JSON...) — count those (main process, not renderer).
// Also mirrors every main-process console.log/console.error line into the debug log file.
let mainProcessUnhandledCount = 0;
const realConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('"msg":"unhandled.rejection"')) mainProcessUnhandledCount++;
  dbg('main-process stderr: ' + args.map(String).join(' '));
  realConsoleError(...args);
};
for (const level of ['info', 'warn']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    dbg(`main-process ${level}: ` + args.map(String).join(' '));
    real(...args);
  };
}
const realConsoleLog = console.log.bind(console);
console.log = (...args) => {
  dbg('main-process stdout: ' + args.map(String).join(' '));
  realConsoleLog(...args);
};

const PID_FILE = path.join(require('node:os').tmpdir(), 'brawl-fake-deadlock.pid');

// Sets React-controlled selects the way a person would (native value setter + change event).
const SET_SELECT_JS = `
  function __setSelect(sel, value) {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function __setHero(name) {
    const el = document.querySelector('.hero-select');
    if (!el) return false;
    const opt = [...el.options].find((o) => o.textContent.includes(name));
    if (!opt) return false;
    return __setSelect('.hero-select', opt.value);
  }
`;

// Clicks the control window's test-mode button (the same one a person presses).
const CLICK_TEST_MODE_JS = `(() => { const b = document.querySelector('.brawl-testmode button'); if (!b) return false; b.click(); return true; })()`;

// Uncaught main-process exceptions (what surfaces as the "A JavaScript error occurred in the main process"
// dialog for a person) are counted here instead of showing a dialog.
let uncaughtCount = 0;
process.on('uncaughtException', (err) => {
  uncaughtCount++;
  dbg('main-process uncaughtException: ' + (err && err.stack ? err.stack : String(err)));
});

// Must run before any stopFakeWindow()/finish() call: lists every window titled exactly "Deadlock" and
// fails hard if one exists that this harness did not itself start (i.e. its pid isn't the one recorded by
// fake-deadlock.ps1's own pid file). Nothing is stopped either way — that's fake-deadlock.ps1 -Stop's job,
// scoped to its own pid file.
function checkNoRealGameOpen() {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-Process | Where-Object { $_.MainWindowTitle -eq 'Deadlock' } | Select-Object -ExpandProperty Id",
    ],
    { encoding: 'utf8' },
  );
  const titledDeadlock = (ps.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const ourPid = fs.existsSync(PID_FILE) ? Number(fs.readFileSync(PID_FILE, 'utf8').trim()) : null;
  const foreign = titledDeadlock.filter((p) => p !== ourPid);
  if (foreign.length > 0) {
    check(
      'real-game-open',
      false,
      `pid(s) ${foreign.join(',')} have a window titled 'Deadlock' that this harness did not start`,
    );
    return false;
  }
  return true;
}

async function main() {
  const timeout = setTimeout(() => {
    console.log('HARNESS TIMEOUT');
    finish(1);
  }, HARD_TIMEOUT_MS);

  if (!checkNoRealGameOpen()) {
    clearTimeout(timeout);
    const report = { platform: process.platform, electron: process.versions.electron, checks };
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    return app.exit(1);
  }

  await app.whenReady();
  check('platform', process.platform === 'win32', `process.platform=${process.platform}`);

  if (only && only.includes('selftest-fail')) {
    // Deliberately failing check, proving the harness itself can fail. Only runs when explicitly requested.
    check('selftest-fail', false, 'intentional failure to prove the harness can fail');
  }

  // main.js is built as ESM ("type": "module"), so a plain require() fails -- use import().
  await import(require('node:url').pathToFileURL(path.join(ROOT, 'electron-dist', 'main.js')).href);
  const e2e = await waitFor(() => globalThis.__brawlE2E, 10_000);
  if (!e2e) {
    check('app-boot', false, 'globalThis.__brawlE2E never appeared -- main.js did not finish whenReady');
    return finish(1);
  }
  const control = await waitFor(() => e2e.getControl(), 10_000);
  const overlay = await waitFor(() => e2e.getOverlay(), 10_000);
  if (!control) {
    check('app-boot', false, 'control window never created');
    return finish(1);
  }

  let captureAttempts = 0;
  control.webContents.on('console-message', (_e, _level, message) => {
    dbg('control console: ' + message);
    if (/"msg":"capture\.attempt"/.test(message)) captureAttempts++;
  });
  overlay?.webContents.on('console-message', (_e, _level, message) => dbg('overlay console: ' + message));
  let preloadError = false;
  control.webContents.on('preload-error', () => (preloadError = true));
  overlay?.webContents.on('preload-error', () => (preloadError = true));

  await waitFor(() => control.webContents.executeJavaScript('document.readyState === "complete"'), 10_000);
  const js = (w, code) => w.webContents.executeJavaScript(code);
  const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'frames', 'labels.json'), 'utf8'));
  const verdicts = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'win-e2e-verdicts.json'), 'utf8'));

  if (wantsCase('boot')) {
    check('preload', (await js(control, 'typeof window.brawlAPI')) === 'object', 'control window brawlAPI');
    let bodyLen = 0;
    const rendered = await waitFor(async () => {
      bodyLen = await js(control, 'document.body.innerText.length');
      return bodyLen > 50;
    }, 10_000);
    check('render', !!rendered, `body.innerText.length=${bodyLen}`);
    check('no-preload-error', !preloadError);
  }

  if (wantsCase('capture-denied')) {
    // No Deadlock window: capture is denied, the status says so, and nothing retries in a loop.
    await waitFor(
      async () =>
        captureAttempts >= 1 &&
        (await js(control, 'document.querySelector(".brawl-status")?.textContent ?? ""')).includes(
          'Deadlock window not found',
        ),
      4_000,
      100,
    );
    const status = await js(control, 'document.querySelector(".brawl-status")?.textContent ?? ""');
    check(
      'capture-denied-status',
      captureAttempts >= 1 && status.includes('Deadlock window not found'),
      `attempts=${captureAttempts} status="${status}"`,
    );
    const before = captureAttempts;
    mainProcessUnhandledCount = 0;
    await sleep(1000);
    check('no-retry-loop', captureAttempts - before <= 1, `attempts in 1s: ${captureAttempts - before}`);
    check('no-unhandled', mainProcessUnhandledCount === 0, `count=${mainProcessUnhandledCount}`);
    check('overlay-hidden-without-game', !overlay || !overlay.isVisible(), `overlayVisible=${overlay?.isVisible()}`);
  }

  if (wantsCase('testmode')) {
    // Debug panel: hidden at launch, Ctrl+Shift+D toggles it, the tray entry toggles the same state.
    const hasDebug = () => js(control, '!!document.querySelector("[aria-label=\\"Debug panel\\"]")');
    const slim = await js(
      control,
      '({ selects: document.querySelectorAll("select").length, btn: /Start capture|Stop capture/.test(document.body.innerText) })',
    );
    check('debug-hidden-at-launch', !(await hasDebug()) && slim.btn && slim.selects <= 1, JSON.stringify(slim));
    const key = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', ctrlKey: true, shiftKey: true }))`;
    await js(control, key);
    await waitFor(hasDebug, 3000, 100);
    const dbgParts = await js(
      control,
      `(() => ['Round','Choice','Enemy 1'].every((l) => !!document.querySelector('select[aria-label="' + l + '"]')) && !!document.querySelector('.brawl-testmode button') && document.body.innerText.includes('Owned'))()`,
    );
    check('debug-shortcut-shows', (await hasDebug()) && dbgParts, 'Ctrl+Shift+D shows test mode/round/choice/enemies/owned');
    await js(control, key);
    await waitFor(async () => !(await hasDebug()), 3000, 100);
    check('debug-shortcut-hides', !(await hasDebug()), 'second press hides');
    e2e.toggleDebugFromTray();
    const trayShown = await waitFor(hasDebug, 3000, 100);
    check('debug-tray-toggle', !!trayShown, 'tray entry handler shows the panel');
    const c1 = labels.choice1;
    await js(
      control,
      `(() => { ${SET_SELECT_JS}
      __setHero(${JSON.stringify(c1.hero)});
      __setSelect('select[aria-label="Round"]', ${c1.round});
      __setSelect('select[aria-label="Choice"]', ${c1.choice}); })()`,
    );
    await sleep(300);
    const setFrame = (name) =>
      js(
        control,
        `(() => { ${SET_SELECT_JS} return __setSelect('select[aria-label="Test screenshot"]', ${JSON.stringify(name)}); })()`,
      );
    const readOverlay = () =>
      js(
        overlay,
        `({
        drawn: window.__overlayDrawn ?? [],
        head: document.querySelector('.overlay-panel-head')?.textContent ?? '',
        panel: !!document.querySelector('.overlay-panel'),
        ap: !!document.querySelector('.ap'),
        now: [...document.querySelectorAll('.ap-col')].flatMap((c) => [
          ...[...c.querySelectorAll('.ap-pill[data-state="now"]')].map(
            (p) => c.dataset.ability + '|' + ({ 5: 'tier3', 2: 'tier2', 1: 'tier1' })[p.dataset.cost],
          ),
        ]).sort(),
        done: document.querySelectorAll('.ap-pill[data-state="done"]').length,
        cards: [...document.querySelectorAll('.overlay-panel-card')].map((e) => e.textContent).join(' | '),
        scores: [...document.querySelectorAll('.overlay-panel-card')]
          .map((e) => (e.textContent || '').match(/ · (-?[0-9.]+) ·/)?.[1]).filter(Boolean),
      })`,
      );

    // --- blank before any draft: test mode on with the in-round frame -> nothing drawn (before advice) ---
    const clicked = await js(control, CLICK_TEST_MODE_JS);
    const win = await waitFor(() => e2e.getTestWindow(), 8_000);
    check(
      'testmode-on',
      clicked && !!win && win.getTitle() === 'Deadlock',
      `clicked=${clicked} title=${win?.getTitle()}`,
    );
    if (!win) return finish(1);
    const namesOf = (l) => Object.values(l.cards);
    const waitAdvice = async (label, round, choice, timeoutMs) => {
      let last = null;
      const start = Date.now();
      const ok = await waitFor(
        async () => {
          last = await readOverlay();
          return last.panel &&
            last.head.includes(`round ${round}, choice ${choice}`) &&
            namesOf(label).every((n) => last.cards.includes(n))
            ? last
            : null;
        },
        timeoutMs,
        50,
      );
      return { ok: !!ok, ms: Date.now() - start, last };
    };
    // Warm up on the in-round frame (capture start-up is not what the 2 s bound measures); nothing may be
    // drawn.
    await setFrame('gameplay');
    await waitFor(
      () => captureAttempts >= 1 && js(control, '!!document.querySelector("video")?.videoWidth'),
      6_000,
      100,
    );
    await sleep(600);
    await setFrame('choice1');
    const first = await waitAdvice(c1, c1.round, c1.choice, 2_000);
    check(
      'advice-choice1',
      first.ok,
      `${first.ms}ms (limit 2000ms) head="${first.last?.head}" cards="${first.last?.cards}"`,
    );

    // Overlay geometry + click-through while the draft is up.
    const bounds = win.getBounds();
    const ob = overlay.getBounds();
    const near = (a, b, t) => Math.abs(a - b) <= t;
    check(
      'overlay-on-draft',
      overlay.isVisible() &&
        overlay.isAlwaysOnTop() &&
        near(ob.x, bounds.x, 3) &&
        near(ob.y, bounds.y, 3) &&
        near(ob.width, bounds.width, 3) &&
        near(ob.height, bounds.height, 3),
      `overlay=${JSON.stringify(ob)} dummy=${JSON.stringify(bounds)} visible=${overlay.isVisible()}`,
    );
    check(
      'click-through',
      !!e2e.overlayIgnoresMouseEvents,
      `overlayIgnoresMouseEvents=${e2e.overlayIgnoresMouseEvents}`,
    );

    // Boxes vs the hand-measured labels, scores vs the panel, plus real canvas pixels.
    const vid = await js(
      control,
      '(() => { const v = document.querySelector("video"); return v ? { w: v.videoWidth, h: v.videoHeight } : null; })()',
    );
    const expected = verdicts.choice1?.verdict ?? null;
    const bestPos = Object.entries(c1.cards).find(([, n]) => n === expected)?.[0] ?? null;
    let boxesOk = !!vid && !!bestPos;
    const detail = [];
    const cur = await readOverlay();
    if (vid) {
      const scale = vid.w / 2000;
      for (const k of ['left', 'top', 'right']) {
        const lb = scaleBox(c1.circles[k], scale);
        const d = cur.drawn.find((r) => r.card === k);
        const s = d ? iou(lb, d) : 0;
        const kindOk = !!d && d.kind === (k === bestPos ? 'best' : 'card');
        const scoreOk = !!d && typeof d.score === 'number' && cur.scores.includes(d.score.toFixed(2));
        detail.push(`${k}:iou=${s.toFixed(2)},kind=${d?.kind ?? 'none'},score=${d?.score ?? 'none'}`);
        if (s < 0.5 || !kindOk || !scoreOk) boxesOk = false;
      }
    }
    check('boxes-choice1', boxesOk, detail.join(' '));
    if (vid && bestPos) {
      await js(overlay, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const px = await checkPixels(overlay, c1, vid, bestPos, 'choice1');
      check('pixels-choice1', px.pass, px.detail);
    }

    // Forced re-roll box (no frame naturally verdicts RE-ROLL).
    if (e2e.forceReroll()) {
      await waitFor(async () => (await readOverlay()).drawn.some((r) => r.kind === 'reroll'), 3_000, 100);
      const d = (await readOverlay()).drawn.find((r) => r.kind === 'reroll');
      const s = d && vid ? iou(scaleBox(c1.boxes.reroll, vid.w / 2000), d) : 0;
      check('reroll-box', s >= 0.5, `iou=${s.toFixed(2)}`);
      // next real state replaces the forced one (advice re-sent on change only): switch frame below re-syncs
    }

    // --- five draft-frame switches: panel round/choice + card names match the frame within 2 s each ---
    const seq = ['choice2', 'choice1', 'choice2', 'choice1', 'choice2'];
    const results = [];
    for (const name of seq) {
      const l = labels[name];
      // round/choice are not touched: the page takes them from the frame's own labels on accept (a real player never sets them)
      await setFrame(name);
      const r = await waitAdvice(l, l.round, l.choice, 2_000);
      results.push(`${name}:${r.ok ? 'ok' : 'FAIL'}@${r.ms}ms`);
      if (!r.ok) results.push(`(head="${r.last?.head}" cards="${r.last?.cards}")`);
      else if (r.ms > 2000) results.push('SLOW');
    }
    check(
      'switch-5x',
      results.every((s) => !s.includes('FAIL') && s !== 'SLOW'),
      results.join(' '),
    );

    // --- leave the draft: gameplay frame -> ability panel with this round's points highlighted, then gone ---
    const expectedNow = await js(
      control,
      `(() => {
        // the control window's own panel for this round: the overlay must show the same pills and the round's points
        return [...document.querySelectorAll('.ap-control .ap-col')].flatMap((c) =>
          [...c.querySelectorAll('.ap-pill[data-state="now"]')].map(
            (p) => c.dataset.ability + '|' + ({ 5: 'tier3', 2: 'tier2', 1: 'tier1' })[p.dataset.cost],
          ),
        ).sort();
      })()`,
    );
    await setFrame('gameplay');
    const tipSeen = await waitFor(
      async () => {
        const s = await readOverlay();
        return s.ap && !s.panel ? s : null;
      },
      6_000,
      100,
    );
    const tipStart = Date.now();
    check(
      'ability-panel-appears',
      !!tipSeen && tipSeen.now.length > 0 && JSON.stringify(tipSeen.now) === JSON.stringify(expectedNow),
      `expected=${JSON.stringify(expectedNow)} highlighted=${JSON.stringify(tipSeen?.now ?? null)}`,
    );
    check(
      'ability-panel-no-drawing',
      !!tipSeen && tipSeen.drawn.length === 0,
      JSON.stringify(tipSeen?.drawn.map((r) => r.kind)),
    );
    check('ability-panel-overlay-visible', overlay.isVisible(), `visible=${overlay.isVisible()}`);
    const gone = await waitFor(async () => !(await readOverlay()).ap, TIP_MS + 2_000, 100);
    const shown = Date.now() - tipStart;
    check(
      'ability-panel-expires',
      !!gone && shown >= TIP_MS - 800 && shown <= TIP_MS + 2_500,
      `shown ~${shown}ms (harness duration ${TIP_MS}ms)`,
    );
    await sleep(400);
    const after = await readOverlay();
    check(
      'blank-after-panel',
      after.drawn.length === 0 && !after.panel && !after.ap && !overlay.isVisible(),
      `drawn=${after.drawn.length} panel=${after.panel} ap=${after.ap} overlayVisible=${overlay.isVisible()}`,
    );

    // --- reopening the draft ends a running panel at once: draft -> gameplay -> draft ---
    const l1 = labels.choice1;
    await js(
      control,
      `(() => { ${SET_SELECT_JS}
      __setSelect('select[aria-label="Round"]', ${l1.round});
      __setSelect('select[aria-label="Choice"]', ${l1.choice}); })()`,
    );
    await setFrame('choice1');
    await setFrame('gameplay');
    await waitFor(async () => (await readOverlay()).ap, 6_000, 100);
    await setFrame('choice1');
    const ended = await waitFor(
      async () => {
        const s = await readOverlay();
        return s.drawn.length > 0 && !s.ap ? s : null;
      },
      3_000,
      100,
    );
    check('panel-ends-on-draft', !!ended, `drawn kinds=${JSON.stringify(ended?.drawn.map((r) => r.kind) ?? null)}`);

    // --- off ---
    await js(control, CLICK_TEST_MODE_JS);
    const closed = await waitFor(() => !e2e.getTestWindow(), 6_000);
    await sleep(300);
    check(
      'testmode-off',
      !!closed && !overlay.isVisible() && !control.isDestroyed(),
      `dummy=${e2e.getTestWindow() ? 'open' : 'closed'} overlayVisible=${overlay.isVisible()}`,
    );
  }

  if (wantsCase('overlay-closed')) {
    // Closing the overlay window must not leave anything that throws later: test mode on/off still works.
    uncaughtCount = 0;
    overlay?.close();
    await sleep(300);
    await js(control, CLICK_TEST_MODE_JS);
    const win = await waitFor(() => e2e.getTestWindow(), 8_000);
    await sleep(400);
    const ov2 = e2e.getOverlay();
    await js(control, CLICK_TEST_MODE_JS);
    await waitFor(() => !e2e.getTestWindow(), 6_000);
    check(
      'overlay-closed-no-error',
      uncaughtCount === 0 && !!win && !!ov2,
      `uncaught=${uncaughtCount} dummy=${win ? 'opened' : 'none'} overlayRecreated=${!!ov2}`,
    );
  }

  clearTimeout(timeout);
  finish(checks.every((c) => c.pass) ? 0 : 1);
}

// Intersection-over-union of two {x0,y0,x1,y1} rects in the same coordinate space.
function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0),
    y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1),
    y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function scaleBox(box, scale) {
  return { x0: box.x0 * scale, y0: box.y0 * scale, x1: box.x1 * scale, y1: box.y1 * scale };
}

async function checkPixels(overlay, label, vidSize, expectedBestPos, frameName) {
  const canvasSize = await overlay.webContents.executeJavaScript(
    '(() => { const c = document.querySelector("canvas"); return c ? { w: c.width, h: c.height } : null; })()',
  );
  if (!canvasSize) return { pass: false, detail: `${frameName}: no overlay canvas` };
  const scaleFrameToCanvas = { x: canvasSize.w / vidSize.w, y: canvasSize.h / vidSize.h };
  const scaleLabelToFrame = vidSize.w / 2000;
  // The best circle's outline must be green and the other circles' outlines grey: look at the
  // strongest pixel within a few px of the circle's leftmost point.
  const img = await overlay.webContents.capturePage();
  const imgSize = img.getSize();
  const bitmap = img.toBitmap(); // BGRA on Windows
  const sampleNear = (box) => {
    const cx = box.x0 * scaleFrameToCanvas.x;
    const cy = ((box.y0 + box.y1) / 2) * scaleFrameToCanvas.y;
    const ix = Math.round(cx * (imgSize.width / canvasSize.w));
    const iy = Math.round(cy * (imgSize.height / canvasSize.h));
    let best = [0, 0, 0, 0];
    for (let dx = -4; dx <= 4; dx++) {
      const x = Math.min(Math.max(ix + dx, 0), imgSize.width - 1);
      const y = Math.min(Math.max(iy, 0), imgSize.height - 1);
      const idx = (y * imgSize.width + x) * 4;
      const px = [bitmap[idx + 2], bitmap[idx + 1], bitmap[idx], bitmap[idx + 3]];
      // strongest = most saturated-or-bright: green stroke beats its antialiased edge, grey beats background
      const w = (p) => p[0] + p[1] + p[2] + 3 * (Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]));
      if (w(px) > w(best)) best = px;
    }
    return best;
  };
  const bestPx = sampleNear(scaleBox(label.circles[expectedBestPos], scaleLabelToFrame));
  const others = ['left', 'top', 'right'].filter((k) => k !== expectedBestPos);
  const otherPx = others.map((k) => sampleNear(scaleBox(label.circles[k], scaleLabelToFrame)));
  const isGreen = (p) => p[1] >= 170 && p[1] - p[0] >= 80 && p[1] - p[2] >= 80;
  const isGrey = (p) => p[0] > 40 && Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 30;
  return {
    pass: isGreen(bestPx) && otherPx.every(isGrey),
    detail: `${frameName}: bestEdge=${JSON.stringify(bestPx)} otherEdges=${JSON.stringify(otherPx)}`,
  };
}

function finish(code) {
  const report = { platform: process.platform, electron: process.versions.electron, checks };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  stopFakeWindow();
  app.exit(code);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  check('harness-error', false, err.message);
  finish(1);
});
