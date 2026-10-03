// Windows-only Electron test harness. Run by real electron.exe (never Linux Electron): sets BRAWL_E2E=1,
// requires the REAL electron-dist/main.js (not a stub), drives it via executeJavaScript, and writes one
// JSON report. Filter cases with --only <name1,name2,...>. Everything runs against the app's own Test mode
// dummy window. Hard timeout 40 s; a full run takes ~25 s. The ability panel lasts TIP_MS here (BRAWL_TIP_MS, 1.2 s) instead of the real 15 s.
'use strict';
process.env.BRAWL_E2E = '1';
const TIP_MS = 1200;
process.env.BRAWL_TIP_MS = String(TIP_MS);
const HARD_TIMEOUT_MS = 40_000;

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { app } = require('electron');
// A dummy window sitting under other windows must keep rendering (and being capturable): no occlusion throttling.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,AllowWgcWindowCapturer');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const ROOT = path.join(__dirname, '..', '..');
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

// Fails hard if any window titled exactly "Deadlock" is already open (a real game). Nothing is stopped.
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
  if (titledDeadlock.length > 0) {
    check(
      'real-game-open',
      false,
      `pid(s) ${titledDeadlock.join(',')} have a window titled 'Deadlock' that this harness did not start`,
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
    check(
      'debug-shortcut-shows',
      (await hasDebug()) && dbgParts,
      'Ctrl+Shift+D shows test mode/round/choice/enemies/owned',
    );
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
        head: window.__overlayAdvice ? window.__overlayAdvice.hero + ' · round ' + window.__overlayAdvice.round + ', choice ' + window.__overlayAdvice.choice : '',
        panel: !!window.__overlayAdvice,
        ap: !!document.querySelector('.ap'),
        now: [...document.querySelectorAll('.ap-col')].flatMap((c) => [
          ...[...c.querySelectorAll('.ap-pill[data-state="now"]')].map(
            (p) => c.dataset.ability + '|' + ({ 5: 'tier3', 2: 'tier2', 1: 'tier1' })[p.dataset.cost],
          ),
        ]).sort(),
        done: document.querySelectorAll('.ap-pill[data-state="done"]').length,
        cards: (window.__overlayAdvice?.ranked ?? []).map((r) => r.name).join(' | '),
        scores: (window.__overlayAdvice?.ranked ?? []).map((r) => r.score.toFixed(2)),
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
    // Frameless control window with its own 32 px strip, no menu; a drag region that buttons are excluded from.
    const strip = await js(
      control,
      `(() => { const t = document.querySelector('.titlebar'); if (!t) return null; const cs = getComputedStyle(t);
        const b = document.querySelector('.titlebar-btn');
        return { h: t.getBoundingClientRect().height, drag: cs.webkitAppRegion, btn: getComputedStyle(b).webkitAppRegion,
          name: t.textContent, sel: getComputedStyle(document.body).userSelect }; })()`,
    );
    const cb = control.getBounds(),
      cc = control.getContentBounds();
    check(
      'titlebar-frameless',
      !!strip &&
        strip.h === 32 &&
        strip.drag === 'drag' &&
        strip.btn === 'no-drag' &&
        strip.name.includes('Deadlock Street Brawl Helper') &&
        strip.sel === 'none' &&
        Math.abs(cb.width - cc.width) <= 2 &&
        Math.abs(cb.height - cc.height) <= 2 &&
        !control.isMenuBarVisible(),
      `strip=${JSON.stringify(strip)} bounds=${JSON.stringify(cb)} content=${JSON.stringify(cc)} menu=${control.isMenuBarVisible()}`,
    );
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
    // --- lobby status dot (non-draft frame), hover line, detect-miss ---
    {
      const dot = await waitFor(() => js(overlay, 'window.__overlayDot ?? null'), 3_000, 100);
      const ow = overlay.getBounds();
      const k = ow.height / 1080;
      check(
        'dot-drawn-lobby',
        !!dot &&
          dot.state === 'watching' &&
          String(dot.color).toLowerCase() === '#2ec4b6' &&
          Math.abs(dot.cx - (12 * k + 5 * k)) <= 2 &&
          Math.abs(dot.cy - (12 * k + 5 * k)) <= 2 &&
          Math.abs(dot.r - 5 * k) <= 1,
        `dot=${JSON.stringify(dot)} overlayH=${ow.height}`,
      );
      if (dot) {
        overlay.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(dot.cx), y: Math.round(dot.cy) });
        const want = 'Brawl Helper: watching for draft. F8 = detect now';
        const t0 = Date.now();
        const tip = await waitFor(() => js(overlay, `window.__overlayDotTip ?? null`), 1_000, 10);
        const shown = await js(overlay, `document.querySelector('.overlay-dot-tip')?.textContent ?? null`);
        check(
          'dot-hover-line',
          tip === want && shown === want && Date.now() - t0 <= 150 + 60,
          `${Date.now() - t0}ms tip=${JSON.stringify(tip)} shown=${JSON.stringify(shown)}`,
        );
        overlay.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(ow.width / 2),
          y: Math.round(ow.height / 2),
        });
        const gone = await waitFor(() => js(overlay, `!document.querySelector('.overlay-dot-tip')`), 1_000, 10);
        check(
          'dot-hover-leaves-clickthrough',
          !!gone && !!e2e.overlayIgnoresMouseEvents,
          `gone=${!!gone} ignoresMouse=${e2e.overlayIgnoresMouseEvents}`,
        );
      }
      // Detect now on a non-draft frame: "No draft found" within the limit, capture ends off, nothing drawn.
      const statusText = () =>
        js(control, `document.querySelector('.brawl-controls [role=status]')?.textContent ?? ''`);
      const captureBtn = () => js(control, `document.querySelector('.brawl-capture')?.textContent ?? ''`);
      e2e.forceCaptureOff();
      await waitFor(async () => (await captureBtn()) === 'Start capture', 4_000, 50);
      const m0 = Date.now();
      e2e.detectNow();
      const missed = await waitFor(async () => (await statusText()) === 'No draft found', 4_000, 20);
      const missMs = Date.now() - m0;
      await sleep(400);
      const after = await readOverlay();
      check(
        'detect-miss',
        !!missed &&
          missMs <= 2_000 &&
          (await captureBtn()) === 'Start capture' &&
          after.drawn.length === 0 &&
          !after.panel,
        `status=${JSON.stringify(await statusText())} ${missMs}ms (limit 2000ms) btn=${await captureBtn()} drawn=${after.drawn.length}`,
      );
      e2e.forceCaptureOff(); // stay off; setFrame below releases the hold
    }
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
      const cards = cur.drawn.filter((d) => d.plate && (d.kind === 'best' || d.kind === 'card'));
      const px = await checkPixels(overlay, { cards, frameW: vid.w, frameH: vid.h }, bestPos);
      check('pixels-choice1', px.pass, px.detail);

      // Hover: a mouse move over the best plate opens the score breakdown within 150 ms; leaving closes it. The overlay
      // keeps ignoring mouse events (click-through) throughout.
      const bestDrawn = cards.find((d) => d.card === bestPos);
      const ovSize = await js(overlay, '({ w: window.innerWidth, h: window.innerHeight })');
      const hx = Math.round(((bestDrawn.plate.x0 + bestDrawn.plate.x1) / 2) * (ovSize.w / vid.w));
      const hy = Math.round(((bestDrawn.plate.y0 + bestDrawn.plate.y1) / 2) * (ovSize.h / vid.h));
      const t0 = Date.now();
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: hx, y: hy });
      const tip = await waitFor(
        () =>
          js(
            overlay,
            `document.querySelector('.overlay-tip') ? [...document.querySelectorAll('.overlay-tip .tip-head, .overlay-tip .tip-row')].map((e) => e.textContent) : null`,
          ),
        1_000,
        10,
      );
      const tipMs = Date.now() - t0;
      const tipRows = tip ?? [];
      const tipTotal = Number((tipRows[tipRows.length - 1] ?? '').replace('Score', '').trim());
      check(
        'tooltip-on-hover',
        !!tip &&
          tipMs <= 150 &&
          tipRows.length >= 3 &&
          tipRows[0].includes(c1.cards[bestPos]) &&
          tipRows.some((r) => r.startsWith('Score')) &&
          cur.scores.includes(tipTotal.toFixed(2)),
        `${tipMs}ms rows=${JSON.stringify(tipRows)}`,
      );
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
      const tipGone = await waitFor(() => js(overlay, `!document.querySelector('.overlay-tip')`), 1_000, 10);
      check(
        'tooltip-leaves',
        !!tipGone && !!e2e.overlayIgnoresMouseEvents,
        `gone=${!!tipGone} ignoresMouse=${e2e.overlayIgnoresMouseEvents}`,
      );
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

    // --- detect-hit: capture forced off on a draft frame, Detect now brings the plates up; dot gone in the match ---
    {
      await setFrame('choice1');
      e2e.forceCaptureOff();
      await waitFor(
        async () =>
          (await js(control, `document.querySelector('.brawl-capture')?.textContent ?? ''`)) === 'Start capture',
        4_000,
        50,
      );
      const l = labels.choice1;
      const t0 = Date.now();
      e2e.detectNow();
      const r = await waitAdvice(l, l.round, l.choice, 4_000);
      const dotNow = await js(overlay, 'window.__overlayDot ?? null');
      check('detect-hit', r.ok && !dotNow, `${Date.now() - t0}ms (target ~2000ms) dot=${JSON.stringify(dotNow)}`);
      check(
        'f8-registered',
        e2e.getF8().registered === true || e2e.getF8().inUse === true,
        JSON.stringify(e2e.getF8()),
      );
    }
    // --- the control window stays where it is put (capture on, test mode on, draft showing) ---
    {
      const spots = [
        { x: 40, y: 50, width: 460, height: 640 },
        { x: 220, y: 120, width: 520, height: 600 },
        { x: 80, y: 30, width: 400, height: 500 },
      ];
      const reads = [];
      let same = true;
      for (const sp of spots) {
        control.setBounds(sp);
        await sleep(250);
        const b = control.getBounds();
        reads.push(b);
        if (
          Math.abs(b.x - sp.x) > 2 ||
          Math.abs(b.y - sp.y) > 2 ||
          Math.abs(b.width - sp.width) > 2 ||
          Math.abs(b.height - sp.height) > 2
        )
          same = false;
      }
      await sleep(3_000);
      const last = control.getBounds();
      // DIP->physical rounding at fractional display scale (125%) moves values by 1-2 px; what matters is no drift afterwards.
      const first = reads[2];
      const stable =
        last.x === first.x && last.y === first.y && last.width === first.width && last.height === first.height;
      check(
        'window-bounds-stable',
        same && stable,
        `set=${JSON.stringify(spots)} read=${JSON.stringify(reads)} after3s=${JSON.stringify(last)} scale=${require('electron').screen.getPrimaryDisplay().scaleFactor}`,
      );
    }

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

// Reads the overlay canvas's own pixels (alpha-aware, unlike capturePage on a transparent window) and checks: the best
// plate is filled teal, the other plates are not, the best card has a teal outline, the others have none.
async function checkPixels(overlay, drawn, bestPos) {
  const px = await overlay.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas');
      const ctx = c.getContext('2d');
      const at = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      const sx = c.width / ${JSON.stringify(drawn.frameW)}, sy = c.height / ${JSON.stringify(drawn.frameH)};
      return ${JSON.stringify(drawn.cards)}.map((d) => ({
        card: d.card,
        // inside the plate, 4 px from its right end, vertically centred: the fill, clear of the text
        fill: at(d.plate.x1 * sx - 4, ((d.plate.y0 + d.plate.y1) / 2) * sy),
        // on the card's outline: left edge of the card box, vertically centred
        edge: [-1, 0, 1].map((dx) => at(d.x0 * sx + dx, ((d.y0 + d.y1) / 2) * sy)),
      }));
    })()`,
  );
  const isTeal = (p) => p[3] > 200 && p[1] >= 150 && p[2] >= 140 && p[0] <= 90;
  const best = px.find((p) => p.card === bestPos);
  const others = px.filter((p) => p.card !== bestPos);
  const pass =
    !!best &&
    isTeal(best.fill) &&
    best.edge.some(isTeal) &&
    others.length > 0 &&
    others.every((o) => !isTeal(o.fill) && !o.edge.some(isTeal));
  return { pass, detail: `best=${JSON.stringify(best)} others=${JSON.stringify(others)}` };
}

function finish(code) {
  const report = { platform: process.platform, electron: process.versions.electron, checks };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(code);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  check('harness-error', false, err.message);
  finish(1);
});
