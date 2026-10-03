import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Ability, Hero, Item } from '../types';
import { j, img } from '../data/load';
import {
  adviseDraft,
  enemiesFrom,
  roundTiers,
  topItemsByTier,
  type BrawlAnalytics,
  type BrawlConfig,
  type BrawlInput,
  type CardRead,
  type IconIndex,
  type Offer,
  type RankedOffer,
  type RerollAdvice,
  brawlAbilityOrder,
  abilityStepIndex,
  abilityPanelFor,
  initialTip,
  stepTip,
  shopProbeRect,
  draftRegions,
  BRAWL_LAYOUT,
  REROLL_SEARCH,
  findRerollButton,
  TIP_MS,
  type AbilityPanelData,
  type TipState,
} from '../brawl';
import { createPerf } from '../perf';
import type { FrameRegion, WorkerIn, WorkerOut } from '../brawl/worker';
import {
  BLANK_OVERLAY,
  drawReads,
  gradesFromAdvice,
  scoresFromAdvice,
  type OverlayAdvice,
  type OverlayState,
} from '../brawl/draw';
import { breakdownRows } from '../brawl/breakdown';
import { itemTiers, type BrawlTierListData } from '../brawl/tierlist';
import { AbilityPanel } from './AbilityPanel';
import { ItemTile } from './ItemTile';
import { log } from '../log';
import { usePersisted, isNumber, isNumberArray } from '../hooks/usePersisted';

const FRAME_WAIT_MS = 150; // longest wait for a new video frame before copying anyway
const CAPTURE_MS = 0; // pause between draft frames (the page now waits for a new video frame instead); the worker paces the loop (see worker.ts) so it keeps running while the tab is hidden
// Capture frame rate: the draft screen needs a look a few times a second, everything else barely at all.
// Switched on the fly with track.applyConstraints so a game window nobody is drafting in costs almost nothing.
const DRAFT_FPS = 15;
// Dev only (a production build records nothing): timing summaries every 10 s, see src/perf.ts.
const perf = createPerf(import.meta.env.DEV, 'brawl-view');
const WAITING_STATUS = 'waiting for the draft screen';
const NO_DRAFT_STATUS = 'No draft found';
const DETECT_MISSES = 3; // non-draft results in a row before Detect now says "No draft found" (the first frame is often blank)
const DETECT_TIMEOUT_MS = 4000; // a try that gets no frame at all in this long counts as failed
const CAPTURE_IDLE_MS = 4000; // no draft screen or tip for this long: stop capturing (real game only)
const IDLE_FPS = 4;
const ENEMY_SLOTS = 4;
const isElectron = typeof window !== 'undefined' && !!window.brawlAPI;

interface Props {
  hero: Hero;
  heroes: Hero[];
  items: Item[];
  abilities: Ability[];
  onHero: (id: number, source?: 'detected' | 'manual') => void;
  /** The hidden Debug panel (Ctrl+Shift+D) is open: shows the manual controls and the full advice list. */
  debug?: boolean;
}

/** Street Brawl draft advisor: the three cards on screen (read from a screen capture or typed in), ranked for this hero. */
export function BrawlView({ hero, heroes, items, abilities, onHero, debug = false }: Props) {
  const [loaded, setLoaded] = useState<{ heroId: number; analytics: BrawlAnalytics } | null>(null);
  const [config, setConfig] = useState<BrawlConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = usePersisted('round', isNumber, 1);
  const [choice, setChoice] = useState(1);
  const [rerollsLeft, setRerollsLeft] = useState<number | null>(null); // null: however many the round starts with; set from the on-screen "N Re-Roll Remaining" caption once a frame is read
  const isEnemies = (v: unknown): v is number[] => isNumberArray(v) && v.length === ENEMY_SLOTS;
  const [enemies, setEnemies] = usePersisted('enemies', isEnemies, Array(ENEMY_SLOTS).fill(0));
  const [owned, setOwned] = useState<number[]>([]);
  const [cards, setCards] = useState<Offer[]>([]);
  const [capture, setCapture] = useState<'off' | 'starting' | 'on'>('off');
  const captureStateRef = useRef<'off' | 'starting' | 'on'>('off');
  captureStateRef.current = capture;
  const [status, setStatus] = useState('');
  // Debounced "the item draft screen is up" and the ability tip that follows its closing (see abilityPanelTimer.ts).
  // The overlay draws nothing unless one of them is set.
  const [draftOpen, setDraftOpen] = useState(false);
  const [tip, setTip] = useState<AbilityPanelData | null>(null);
  // Electron only: main.ts denied the last capture attempt (Deadlock isn't open). Blocks the auto-start
  // effect from retrying on every rect tick; cleared once the game window actually appears.
  const [denied, setDenied] = useState(false);
  const [pip, setPip] = useState<Window | null>(null);
  // Electron: Deadlock's window is on screen (from the game-rect feed); the person pressed Stop (blocks auto-start
  // until they press Start); a platform warning from main; a draft screen has been seen this session (hides the how-to).
  const [gameFound, setGameFound] = useState(false);
  const [manualStop, setManualStop] = useState(false);
  const manualStopRef = useRef(false);
  const [platformWarning, setPlatformWarning] = useState<string | null>(null);
  const [draftSeen, setDraftSeen] = useState(false);
  const [f8InUse, setF8InUse] = useState(false);
  // A running Detect now try: pressed-at time; the first frame result decides hit or miss.
  const detectMissesRef = useRef(0);
  const detectRef = useRef<{ at: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [took_, setTook] = useState<string>('');
  const workerRef = useRef<Worker | null>(null);
  const workerStartedRef = useRef(false); // the worker has been sent 'init' (capture loop running or resettable)
  const workerIndexRef = useRef<IconIndex | null>(null);
  const workerTiers = () => {
    const tiers: Record<number, number> = {};
    for (const i of items) tiers[i.id] = i.item_tier;
    return tiers;
  };
  /** Creates the recogniser worker and has it decode the icon index and warm its readers. Called when the app
   *  opens (so the first draft frame is not the one that pays for it) and again from startCapture if needed. */
  const makeWorker = async (): Promise<Worker | null> => {
    if (workerRef.current) return workerRef.current;
    workerIndexRef.current ??= await j<IconIndex>('brawl-icons.json');
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL('../brawl/worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ type: 'warm', index: workerIndexRef.current, tiers: workerTiers() } satisfies WorkerIn);
    workerRef.current = w;
    return w;
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Set by the capture-denied IPC handler below, reset at the start of every startCapture() attempt.
  // main.ts sends this IPC synchronously before getDisplayMedia's promise rejects (see
  // BrawlView.electron.test.tsx's mock), so by the time the catch block below runs it reliably reflects
  // whether *this* attempt was actually denied by main.ts, rather than guessing from the rejection's
  // name/message (which Electron could change without warning).
  const deniedIpcRef = useRef(false);
  // Bumped by every startCapture()/stopCapture() call so a stale, still-in-flight attempt (e.g. the mount-time
  // real getDisplayMedia() call, which can take a while to be denied) can't clobber a newer one's state once it
  // finally settles.
  const captureGenRef = useRef(0);
  const offeredRef = useRef<Set<number>>(new Set()); // every card offered this game: settles inventory reads
  const ownedRef = useRef<number[]>([]);
  const cardsRef = useRef<Offer[]>([]);
  const prevCardsRef = useRef<Offer[]>([]); // the set on screen before the current one: the pick shows up in the grid after the screen has moved on
  const readsRef = useRef<CardRead[]>([]); // latest card positions on screen, for the preview highlight
  const acceptedKeyRef = useRef(''); // last accepted card-set key, to discard a stale async 'rerolls' OCR result
  const rankedRef = useRef<RankedOffer[]>([]);
  const rerollRef = useRef<RerollAdvice | null>(null);
  const overlayAdviceRef = useRef<OverlayAdvice | null>(null);
  // Tier-list letter per item (S/A/B/C), shown in the badge on each plate.
  const [tierData, setTierData] = useState<BrawlTierListData | null>(null);
  useEffect(() => {
    j<BrawlTierListData>('analytics/brawl/tier-list.json')
      .then(setTierData)
      .catch((e) => log('brawl-view', 'warn', 'tierlist.load.fail', { message: String(e) }));
  }, []);
  const gradeById = useMemo(
    () => new Map(tierData ? itemTiers(tierData, items).map((r) => [r.subject.id, r.grade as string]) : []),
    [tierData, items],
  );
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const roundRef = useRef(round);
  const choiceRef = useRef(choice);
  const tipStateRef = useRef<TipState<AbilityPanelData>>(initialTip());
  const abilityTargetRef = useRef<AbilityPanelData | null>(null);
  const draftRef = useRef(false);
  const tipRef = useRef<AbilityPanelData | null>(null);
  const frameDimsRef = useRef({ w: 0, h: 0 });
  const rerollRectRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rerollCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastOverlayJsonRef = useRef('');
  useEffect(() => {
    roundRef.current = round;
  }, [round]);
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);
  useEffect(() => {
    ownedRef.current = owned;
  }, [owned]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    j<BrawlConfig>('brawl-config.json')
      .then(setConfig)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    j<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`)
      .then((a) => setLoaded({ heroId: hero.id, analytics: a }))
      .catch((e) => setError(String(e)));
  }, [hero.id]);
  // tagged with the hero it was fetched for, so switching hero shows the loader again instead of the old hero's numbers
  const analytics = loaded?.heroId === hero.id ? loaded.analytics : null;
  const rerolls = rerollsLeft ?? config?.item_draft_rerolls_per_round[round - 1] ?? 1;

  const input: BrawlInput | null = useMemo(
    () => (analytics && config ? { hero, abilities, items, analytics, config } : null),
    [hero, abilities, items, analytics, config],
  );
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const catalog = useMemo(
    () =>
      items
        .filter((i) => !i.disabled && i.item_tier >= 1 && !/^upgrade_|Disabled/.test(i.name))
        .sort((a, b) => a.item_tier - b.item_tier || a.name.localeCompare(b.name)),
    [items],
  );
  const enemyIds = enemies.filter(Boolean);
  const heroId = hero.id;
  const advice = useMemo(() => {
    if (!input || !cards.length) return null;
    const sets: Offer[][] = [[], [], []];
    sets[choice - 1] = cards;
    return adviseDraft(input, { round, owned, enemies: enemyIds, sets });
  }, [input, cards, round, owned, choice, enemies]);
  const ranked: RankedOffer[] = useMemo(() => advice?.sets[choice - 1] ?? [], [advice, choice]);
  useEffect(() => {
    rankedRef.current = ranked;
  }, [ranked]);
  const reroll = advice?.reroll && rerolls > 0 ? advice.reroll : null;
  useEffect(() => {
    rerollRef.current = reroll;
  }, [reroll]);
  const tiers = input ? roundTiers(input, round) : [];
  const topItems = useMemo(() => (input ? topItemsByTier(input) : []), [input]);
  const abilityOrder = useMemo(() => (input ? brawlAbilityOrder(input) : null), [input]);
  const abilityStepNow = abilityStepIndex(round, choice);
  // The standard point allocation for this round, shown ~15 s after the draft closes (latched then).
  const abilityTarget = useMemo(
    () => (abilityOrder && input ? abilityPanelFor(abilityOrder, hero, input.abilities, round) : null),
    [abilityOrder, input, hero, round],
  );
  useEffect(() => {
    abilityTargetRef.current = abilityTarget;
  }, [abilityTarget]);
  /** Sends the overlay what it may draw, only when that changed since the last send (the overlay is blank unless a
   *  draft screen is up or the tip is running). */
  const pushOverlay = () => {
    const api = window.brawlAPI;
    if (!api) return;
    const draft = draftRef.current,
      tipNow = tipRef.current;
    let state: OverlayState = BLANK_OVERLAY;
    if (draft || tipNow) {
      const rerollNow = !!rerollRef.current;
      state = {
        reads: draft ? readsRef.current : [],
        bestId: rerollNow ? null : (rankedRef.current[0]?.item.id ?? null),
        reroll: rerollNow && draft,
        rerollRect: rerollNow && draft ? rerollRectRef.current : null,
        frameW: frameDimsRef.current.w,
        frameH: frameDimsRef.current.h,
        advice: draft ? overlayAdviceRef.current : null,
        draft,
        panel: tipNow,
      };
    }
    const json = JSON.stringify(state);
    if (json === lastOverlayJsonRef.current) return;
    lastOverlayJsonRef.current = json;
    api.sendOverlayState(state);
  };
  useEffect(() => {
    draftRef.current = draftOpen;
    tipRef.current = tip;
  }, [draftOpen, tip]);
  useEffect(() => {
    overlayAdviceRef.current = input
      ? {
          hero: hero.name,
          round,
          choice,
          reroll: reroll ? { expectedBest: reroll.expectedBest, currentBest: reroll.currentBest } : null,
          ranked: ranked.map((r) => ({
            itemId: r.item.id,
            name: r.item.name,
            score: r.score,
            enhanced: r.enhanced,
            usage: r.usage,
            winRate: r.winRate,
            grade: gradeById.get(r.item.id) ?? '-',
            rows: breakdownRows(r.parts, r.score, r.known),
          })),
          status,
        }
      : null;
    draftRef.current = draftOpen;
    tipRef.current = tip;
    pushOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pushOverlay only reads refs
  }, [input, hero, round, choice, reroll, ranked, draftOpen, tip, status, gradeById]);

  /** Ends a Detect now try and logs `detect.manual` with the outcome. */
  function finishDetect(outcome: 'hit' | 'miss' | 'failed') {
    const d = detectRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    detectRef.current = null;
    log('brawl-view', 'info', 'detect.manual', { outcome, ms: Math.round(performance.now() - d.at) });
  }
  /** F8 / the button / the tray: main has already turned capture on; the first frame result decides (see onMessage). */
  const runDetect = () => {
    if (!isElectron || detectRef.current) return; // presses during a running try are ignored
    const at = performance.now();
    detectMissesRef.current = 0;
    detectRef.current = {
      at,
      timer: setTimeout(() => {
        finishDetect('failed');
        setStatus('capture failed: no frame received');
      }, DETECT_TIMEOUT_MS),
    };
    setStatus('Detecting…');
    // a draft already on screen: throw the old read away and read it again, so the press visibly does something
    if (draftRef.current && workerRef.current) workerRef.current.postMessage({ type: 'reset' } satisfies WorkerIn);
    if (captureStateRef.current === 'off') {
      manualStopRef.current = false;
      setManualStop(false);
      setDenied(false);
      void startCapture();
    }
  };
  const runDetectRef = useRef(runDetect);
  runDetectRef.current = runDetect;

  const stopCapture = useCallback(() => {
    captureGenRef.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    // The worker stays alive but silent (it only ever ticks in reply to a message) so the next draft does not pay for
    // a new worker and icon index; 'stop' frees its OCR engine.
    workerRef.current?.postMessage({ type: 'stop' } satisfies WorkerIn);
    tipStateRef.current = initialTip();
    setDraftOpen(false);
    setTip(null);
    setCapture('off');
    setStatus('');
    log('brawl-view', 'info', 'capture.stop', { gen: captureGenRef.current });
  }, []);
  const hasDpip = () => 'documentPictureInPicture' in window;
  /** Always-on-top overlay in Chrome/Edge (Document Picture-in-Picture); a plain popup window elsewhere (Firefox has no
   *  always-on-top web window, so put the popup on a second monitor or use the phone display). Must run inside a click. */
  const openPip = useCallback(async () => {
    const dpip = (
      window as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }
    ).documentPictureInPicture;
    let w: Window;
    if (dpip) w = await dpip.requestWindow({ width: 460, height: 320 });
    else {
      const popup = window.open('', 'brawl-overlay', 'popup,width=460,height=320');
      if (!popup) {
        setStatus('the browser blocked the overlay window; allow pop-ups for this site');
        return;
      }
      w = popup;
      w.document.title = 'Brawl advice';
      setStatus(
        'overlay opened as a window (this browser has no always-on-top web window: put it on a second monitor)',
      );
    }
    for (const s of Array.from(document.styleSheets)) {
      try {
        const el = document.createElement('style');
        el.textContent = Array.from(s.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        w.document.head.appendChild(el);
      } catch {
        /* cross-origin sheet */
      }
    }
    w.document.body.className = 'pip-body';
    w.addEventListener('pagehide', () => setPip(null));
    setPip(w);
    return w;
  }, []);
  /** One click: start the screen capture (needs the click's user activation) and then open the always-on-top overlay.
   */
  const startCapture = async () => {
    deniedIpcRef.current = false;
    const gen = ++captureGenRef.current;
    try {
      setCapture('starting');
      setStatus('loading icon index…');
      if (workerRef.current && workerStartedRef.current)
        workerRef.current.postMessage({ type: 'reset' } satisfies WorkerIn);
      else {
        const w = workerRef.current ?? (await makeWorker());
        if (!w || gen !== captureGenRef.current) return;
        w.postMessage({
          type: 'init',
          index: workerIndexRef.current!,
          tiers: workerTiers(),
          intervalMs: CAPTURE_MS,
        } satisfies WorkerIn);
        workerStartedRef.current = true;
      }
      // Logged before the call, unlike capture.start below, so a denied/failed attempt still leaves a
      // trace — the e2e harness's retry-loop checks count this line, not capture.start, since a denial
      // never reaches capture.start at all.
      log('brawl-view', 'info', 'capture.attempt');
      {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: IDLE_FPS }, audio: false });
        if (gen !== captureGenRef.current) {
          // superseded while this real getDisplayMedia() request was pending -- drop it
          // instead of adopting a stream nothing asked for, and don't touch state a newer attempt now owns.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        stream.getVideoTracks()[0].addEventListener('ended', stopCapture);
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
      }
      if (gen !== captureGenRef.current) return; // superseded during the await above
      setCapture('on');
      window.brawlAPI?.captureResult?.(true);
      setStatus('watching for the draft screen');
      log('brawl-view', 'info', 'capture.start');
      // Electron already draws its own always-on-top overlay window (electron/main.ts); the in-page
      // Document-PiP overlay is only for the browser path.
      if (!isElectron && !pip && hasDpip()) {
        try {
          await openPip();
        } catch {
          /* overlay is optional */
        }
      } // getDisplayMedia already consumed this click's activation, so requestWindow may need a second click here; that's fine since capture already started
    } catch (e) {
      if (gen !== captureGenRef.current) return; // superseded — a newer attempt owns state now, don't clobber it
      window.brawlAPI?.captureResult?.(false);
      finishDetect('failed');
      stopCapture(); // clears status to '' — always re-set it below, never leave it blank
      const err = e as Error;
      // Only treat this as "Deadlock window not found" when main.ts's capture-denied IPC actually arrived
      // for this attempt (see deniedIpcRef above); any other failure shows the real error message instead
      // of assuming it was a denial.
      const isDenyArtifact = isElectron && deniedIpcRef.current;
      if (isDenyArtifact) {
        setDenied(true);
        setStatus('Deadlock window not found');
        log('brawl-view', 'warn', 'capture.fail', { message: err.message, denyArtifact: true });
      } else {
        setStatus(`capture failed: ${err.message}`);
        log('brawl-view', 'error', 'capture.fail', { message: err.message, denyArtifact: false });
      }
    }
  };
  useEffect(
    () => () => {
      stopCapture();
      workerRef.current?.terminate();
      workerRef.current = null;
      workerStartedRef.current = false;
    },
    [stopCapture],
  );
  // Pre-bake: build and warm the recogniser worker as soon as the app opens (Electron only: the browser path
  // starts from a click), so the first draft frame does not wait for icon decoding and JIT warm-up.
  useEffect(() => {
    if (isElectron) void makeWorker().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Belt-and-braces: if the <video> element instance ever changes (React remounting it for any reason)
  // while a capture stream is live, re-attach it instead of leaving the new element with no srcObject.
  useEffect(() => {
    const v = videoRef.current;
    const stream = streamRef.current;
    if (!v || !stream) return;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      void v.play();
      log('brawl-view', 'info', 'capture.rebind');
    }
  });

  // Electron: no picker to click through (main.ts serves the Deadlock window via setDisplayMediaRequestHandler,
  // or denies the request if Deadlock isn't open) — attempt capture once on mount rather than waiting for the
  // game window to be found first; main.ts's own handler is what decides allow vs. deny.
  useEffect(() => {
    if (!isElectron) return;
    void window.brawlAPI!.getCaptureState().then((st) => {
      captureWantedRef.current = st.wanted;
      probeModeRef.current = st.probe;
      if (!st.probe || st.wanted) void startCapture();
      else setStatus(WAITING_STATUS);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only: never re-attempt here
  }, []);

  // Surfaces main.ts's platform.unsupported warning (Electron not running on real win32, e.g. dev:electron
  // launched inside WSL under WSLg) in the status line, so it's visible instead of only in the log.
  useEffect(() => {
    if (!isElectron) return;
    void window.brawlAPI!.getPlatformWarning().then((warning) => {
      if (warning) {
        setStatus(warning);
        setPlatformWarning(warning);
      }
    });
  }, []);

  // Retry whenever the game window is present but capture isn't running -- covers both a denial (game
  // window wasn't found yet, `denied` set) and the window's capture handle going stale while the window
  // itself stays open (e.g. Windows Graphics Capture invalidates the session on certain window changes;
  // the video track fires "ended" and stopCapture() runs, but never touches `denied`). Retrying only on
  // rect ticks while capture === 'off' (not on every tick unconditionally) avoids a busy loop, since
  // startCapture() flips capture away from 'off' immediately.
  //
  // Whether capture should run at all is main.ts's call (`capture-state`): with a real game it stays off until a
  // cheap screen-region probe sees the draft screen (electron/main.ts), so the game window is not being captured the
  // whole session; under test mode / the harness (`probe: false`) it simply follows the game window.
  const captureWantedRef = useRef(false);
  const probeModeRef = useRef(false);
  useEffect(() => {
    if (!isElectron) return;
    return window.brawlAPI!.onCaptureState((st) => {
      captureWantedRef.current = st.wanted;
      probeModeRef.current = st.probe;
      if (st.wanted && capture === 'off' && !manualStopRef.current) {
        setDenied(false);
        void startCapture();
      } else if (!st.wanted && capture !== 'off') {
        stopCapture();
        if (st.probe) setStatus(WAITING_STATUS);
      }
    });
  }, [capture, denied]);
  // A window that was found a moment ago is sometimes not yet offered by desktopCapturer, so the first attempt
  // is denied and no further state change follows. While capture is wanted and off, retry every 2 s (never
  // otherwise: that would be a busy loop against a denial that cannot succeed).
  useEffect(() => {
    if (!isElectron || capture !== 'off') return;
    const t = setInterval(() => {
      if (captureWantedRef.current && !manualStopRef.current) void startCapture();
    }, 2000);
    return () => clearInterval(t);
  }, [capture]);
  // With a real game the stream is only for the draft: once neither the draft screen nor the ability tip is up for a
  // few seconds, stop capturing and tell main.ts to go back to probing.
  useEffect(() => {
    if (!isElectron || capture !== 'on' || draftOpen || tip || !probeModeRef.current) return;
    const t = setTimeout(() => {
      captureWantedRef.current = false;
      stopCapture();
      setStatus(WAITING_STATUS);
      window.brawlAPI!.captureIdle();
    }, CAPTURE_IDLE_MS);
    return () => clearTimeout(t);
  }, [capture, draftOpen, tip, stopCapture]);

  useEffect(() => {
    if (!isElectron) return;
    const api = window.brawlAPI!;
    void api.getGameRect().then((r) => setGameFound(!!r));
    return api.onGameRect((r) => setGameFound(!!r));
  }, []);
  useEffect(() => {
    if (!isElectron) return;
    const api = window.brawlAPI!;
    void api.getDetectKeyInUse?.().then(setF8InUse);
    const offKey = api.onDetectKeyState?.(setF8InUse);
    const offRun = api.onDetectRun?.(() => runDetectRef.current());
    return () => {
      offKey?.();
      offRun?.();
    };
  }, []);
  useEffect(() => {
    if (draftOpen) setDraftSeen(true);
  }, [draftOpen]);

  // Test mode (Electron): main.ts opens a dummy "Deadlock" window showing a draft screenshot and the normal
  // capture path takes it from there; this just mirrors its state and sends the button/select changes.
  const [testMode, setTestMode] = useState<{ on: boolean; frame: string; frames: string[]; message: string | null }>({
    on: false,
    frame: '',
    frames: [],
    message: null,
  });
  useEffect(() => {
    if (!isElectron) return;
    const api = window.brawlAPI!;
    void api.getTestMode().then(setTestMode);
    return api.onTestMode(setTestMode);
  }, []);

  // Electron: main.ts denies getDisplayMedia (callback({})) instead of falling back to some other window
  // when Deadlock isn't found, so tell the user why capture never starts instead of leaving them guessing.
  // The startCapture catch above also sets this status directly (that promise-rejection path races this IPC
  // message), so both agree on the same text rather than one clobbering the other.
  useEffect(() => {
    if (!isElectron) return;
    return window.brawlAPI!.onCaptureDenied(() => {
      deniedIpcRef.current = true;
      finishDetect('failed');
      setDenied(true);
      setStatus('Deadlock window not found');
    });
  }, []);

  // frame loop: the worker asks for a frame ('tick'), the page draws the video to a canvas and sends the pixels,
  // the worker answers with what it read and asks again after CAPTURE_MS. Nothing here depends on page timers.
  useEffect(() => {
    if (capture !== 'on') return;
    const w = workerRef.current;
    if (!w) return;
    const canvas = document.createElement('canvas'); // the probe crop
    const fullCanvasRef = { current: null as HTMLCanvasElement | null };
    // Video frames presented so far (a persistent requestVideoFrameCallback loop) vs. the count at the last copy.
    const vid = videoRef.current;
    const frames = {
      supported: !!vid && typeof vid.requestVideoFrameCallback === 'function',
      seen: 0,
      copied: 0,
      want: null as (() => void) | null,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      run() {
        clearTimeout(this.timer);
        const f = this.want;
        this.want = null;
        if (f) {
          this.copied = this.seen;
          f();
        }
      },
    };
    let vfcId = 0;
    if (vid && frames.supported) {
      const loop = () => {
        frames.seen++;
        if (frames.want) frames.run();
        vfcId = vid.requestVideoFrameCallback(loop);
      };
      vfcId = vid.requestVideoFrameCallback(loop);
    }
    let lastLoggedSource = '';
    let fpsForShop: boolean | null = null;
    const setFps = (shop: boolean) => {
      if (fpsForShop === shop) return;
      fpsForShop = shop;
      void streamRef.current
        ?.getVideoTracks()[0]
        ?.applyConstraints({ frameRate: shop ? DRAFT_FPS : IDLE_FPS })
        .catch(() => {});
    };
    let tipTimer: ReturnType<typeof setTimeout> | undefined;
    const tipMs = window.brawlAPI?.isE2E && window.brawlAPI.tipMs ? window.brawlAPI.tipMs : TIP_MS;
    // Feeds the debounced draft/tip tracker one frame result, and (re)arms the timer that ends the tip on its own.
    const stepTracker = (shop: boolean) => {
      const next = stepTip(tipStateRef.current, shop, Date.now(), abilityTargetRef.current, tipMs);
      tipStateRef.current = next;
      draftRef.current = next.draft;
      tipRef.current = next.tip?.value ?? null;
      setDraftOpen(next.draft);
      setTip(next.tip?.value ?? null);
      clearTimeout(tipTimer);
      if (next.tip) tipTimer = setTimeout(() => stepTracker(false), Math.max(0, next.tip.endsAt - Date.now()) + 5);
      pushOverlay();
    };
    const sendFrame = (full: boolean) => perf.time(full ? 'copy.draft' : 'copy.probe', () => copyFrame(full));
    const copyFrame = (full: boolean) => {
      const src: CanvasImageSource | null = videoRef.current;
      const srcW = videoRef.current?.videoWidth ?? 0;
      const srcH = videoRef.current?.videoHeight ?? 0;
      const sourceSig = `${videoRef.current ? 'video' : 'none'}:${srcW}x${srcH}:gen=${captureGenRef.current}`;
      if (sourceSig !== lastLoggedSource) {
        lastLoggedSource = sourceSig;
        log('brawl-view', 'debug', 'frame.source', { source: sourceSig });
      }
      if (!src || !srcW) {
        w.postMessage({ type: 'idle' } satisfies WorkerIn);
        return;
      }
      frameDimsRef.current = { w: srcW, h: srcH };
      if (!full) {
        // Not on the draft screen: copy only the "CHOICE n OF 3" crop, not the whole frame.
        const r = shopProbeRect(srcW, srcH);
        canvas.width = r.width;
        canvas.height = r.height;
        const pctx2 = canvas.getContext('2d', { willReadFrequently: true })!;
        pctx2.drawImage(src, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        const crop = pctx2.getImageData(0, 0, r.width, r.height);
        w.postMessage(
          {
            type: 'probe',
            frameW: srcW,
            frameH: srcH,
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            buffer: crop.data.buffer,
          } satisfies WorkerIn,
          [crop.data.buffer],
        );
        return;
      }
      // Only the rectangles the recogniser reads (draftRegions) leave the video, one small canvas each.
      const regions: FrameRegion[] = [];
      const rects = draftRegions(srcW, srcH);
      // One draw of the video per frame, then a cheap read per region: every drawImage from the video costs ~10 ms
      // whatever its size (a GPU sync), so seven region draws were ~70 ms.
      const fc = (fullCanvasRef.current ??= document.createElement('canvas'));
      if (fc.width !== srcW) fc.width = srcW;
      if (fc.height !== srcH) fc.height = srcH;
      const fctx = fc.getContext('2d', { willReadFrequently: true })!;
      fctx.drawImage(src, 0, 0);
      for (const r of rects) {
        const d = fctx.getImageData(r.x, r.y, r.width, r.height);
        regions.push({ ...r, buffer: d.data.buffer });
      }
      if (rerollRef.current && draftRef.current) {
        // Where the "Use Re-Roll" pill really sits on this frame (layouts differ by a few %), so the box hugs it.
        const sx = srcW / BRAWL_LAYOUT.ref.width,
          sy = srcH / BRAWL_LAYOUT.ref.height;
        const x = Math.round(REROLL_SEARCH.x0 * sx),
          y = Math.round(REROLL_SEARCH.y0 * sy),
          w = Math.round((REROLL_SEARCH.x1 - REROLL_SEARCH.x0) * sx),
          h = Math.round((REROLL_SEARCH.y1 - REROLL_SEARCH.y0) * sy);
        const c = (rerollCanvasRef.current ??= document.createElement('canvas'));
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        const rctx = c.getContext('2d', { willReadFrequently: true })!;
        rctx.drawImage(src, x, y, w, h, 0, 0, w, h);
        const found = findRerollButton(rctx.getImageData(0, 0, w, h).data, w, h, x, y, srcW);
        const old = rerollRectRef.current;
        if (found && (!old || Math.abs(old.y0 - found.y0) + Math.abs(old.x0 - found.x0) > 1.5)) {
          rerollRectRef.current = found;
          pushOverlay();
        }
      }
      const prefer = [...offeredRef.current, ...ownedRef.current];
      w.postMessage({ type: 'frame', width: srcW, height: srcH, regions, prefer } satisfies WorkerIn, [
        ...regions.map((r) => r.buffer),
      ]);
      const pv = previewRef.current;
      // the preview only matters while the control window can be seen: skip its full-frame scale-draw otherwise
      if (pv && !document.hidden) {
        const rerollNow = !!rerollRef.current;
        const bestId = rerollNow ? null : (rankedRef.current[0]?.item.id ?? null);
        const pctx = pv.getContext('2d');
        if (pctx) {
          const scale = pv.width / srcW;
          pctx.drawImage(fc, 0, 0, pv.width, pv.height); // the copy just made: a canvas draw, not another video read
          drawReads(
            pctx,
            readsRef.current,
            bestId,
            scale,
            scale,
            srcW,
            srcH,
            rerollNow,
            scoresFromAdvice(overlayAdviceRef.current),
            null,
            gradesFromAdvice(overlayAdviceRef.current),
          );
        }
      }
    };
    const onMessage = (ev: MessageEvent<WorkerOut>) => {
      if (ev.data.type === 'tick') {
        if (ev.data.full) setFps(true); // the probe saw a draft screen: raise the frame rate before the first full read
        const full = ev.data.full;
        // A draft frame is only useful if it is a new picture: the worker accepts a card set when two frames agree, so
        // never copy the same video frame twice. Wait (briefly) for the next one instead of idling a fixed time.
        if (full && frames.copied >= frames.seen && frames.supported) {
          frames.want = () => sendFrame(true);
          clearTimeout(frames.timer);
          frames.timer = setTimeout(() => frames.run(), FRAME_WAIT_MS);
        } else {
          frames.copied = frames.seen;
          sendFrame(full);
        }
        return;
      }
      if (ev.data.type === 'rerolls') {
        // OCR runs off the hot path (see worker.ts); only apply it if the card set it was read for is
        // still the one on screen -- otherwise a slow OCR result from a since-superseded set would
        // overwrite a newer, already-correct count (or the next set's still-pending "-1 unread").
        const applied = ev.data.forKey === acceptedKeyRef.current;
        log('brawl-view', 'info', 'rerolls.read', { value: ev.data.rerollsRemaining, applied });
        if (applied && ev.data.rerollsRemaining >= 0) setRerollsLeft(ev.data.rerollsRemaining);
        return;
      }
      const r = ev.data;
      if (perf.enabled) {
        perf.record(r.shop ? 'worker.draft' : 'worker.probe', r.ms);
        for (const [k, v] of Object.entries(r.stages ?? {})) perf.record(`worker.${k}`, v);
      }
      readsRef.current = r.reads;
      const seen = r.reads.filter((x) => x.present).length;
      if (r.accepted) {
        const offers = r.reads.map(toOffer);
        for (const o of offers) offeredRef.current.add(o.itemId);
        prevCardsRef.current = cardsRef.current;
        cardsRef.current = offers;
        setCards(offers);
        const meta = r.meta!;
        log('brawl-view', 'info', 'worker.accept', {
          round: meta.round,
          choice: meta.choice,
          items: offers.map((o) => o.itemId),
        });
        // Round / choice come from the labels on this very frame. If the round label can't be read (small or
        // scaled windows), the round advances only when the choice wraps back to 1 (3 -> 1, or 2 -> 1 after a skipped frame); anything else keeps the old value.
        // Either way the cards and labels are set together, so the panel never mixes a new set with an old label.
        if (meta.round) {
          setRound(meta.round);
          roundRef.current = meta.round;
        } else if (meta.choice === 1 && choiceRef.current > 1) {
          roundRef.current = Math.min(5, roundRef.current + 1);
          setRound(roundRef.current);
        }
        if (meta.choice) {
          setChoice(meta.choice);
          choiceRef.current = meta.choice;
        }
        acceptedKeyRef.current = r.key;
        // read straight off the "N Re-Roll Remaining" caption instead of inferring a re-roll from a changed
        // card set, so a stale reroll suggestion clears the moment the game's own counter does. 0 here means
        // no glyph at all (confidently zero); -1 means a glyph is showing and the real OCR read (see
        // ocr.ts's readRerollsRemaining) is still pending -- leave the current value alone until the
        // worker's follow-up 'rerolls' message resolves it, rather than overwrite a real count with "unread".
        if (meta.rerollsRemaining >= 0) setRerollsLeft(meta.rerollsRemaining);
        // the square-topped portrait is the player's: switch the app's hero to it (the enemies are then the other side)
        if (!meta.self) {
          log('brawl-view', 'debug', 'hero.detect.miss', { bar: meta.bar });
        }
        const me = meta.self && heroes.some((h) => h.id === meta.self) ? meta.self : heroId;
        if (me !== heroId) {
          const score = [...meta.bar.left, ...meta.bar.right].find((m) => m.heroId === me)?.score;
          log('brawl-view', 'info', 'hero.detect', { from: heroId, to: me, score });
          onHero(me, 'detected');
          setOwned([]);
          offeredRef.current.clear();
        }
        const foes = enemiesFrom(meta.bar, me);
        if (foes.length)
          setEnemies((prev) => {
            const n = [...prev];
            for (const f of foes)
              if (!n.includes(f)) {
                const k = n.indexOf(0);
                if (k < 0) break;
                n[k] = f;
              }
            return n.every((x, i) => x === prev[i]) ? prev : n;
          });
      }
      if (r.inventory) {
        // the grid is the truth for what is owned; a new entry that was on offer is the card just taken
        const before = ownedRef.current,
          after = r.inventory;
        const gained = after.filter((id) => !before.includes(id));
        const pick = gained.find((id) => [...prevCardsRef.current, ...cardsRef.current].some((c) => c.itemId === id));
        if (pick) setTook(byId.get(pick)?.name ?? '');
        if (after.length !== before.length || gained.length) setOwned(after);
      }
      if (!r.shop) {
        readsRef.current = [];
        const pv = previewRef.current;
        pv?.getContext('2d')?.clearRect(0, 0, pv.width, pv.height);
      }
      setFps(r.shop);
      stepTracker(r.shop);
      if (detectRef.current) {
        if (r.shop) finishDetect('hit');
        else if (++detectMissesRef.current < DETECT_MISSES) {
          return;
        } else {
          finishDetect('miss');
          captureWantedRef.current = false;
          stopCapture();
          setStatus(NO_DRAFT_STATUS);
          window.brawlAPI!.detectMiss();
          return;
        }
      }
      const heroDetected = r.accepted && r.meta!.self && r.meta!.self === heroId;
      const names = !r.shop
        ? 'waiting for the shop'
        : seen === 3
          ? r.reads.map((x) => byId.get(x.itemId)?.name ?? '?').join(' / ')
          : heroDetected
            ? `hero: ${hero.name} · ${seen}/3 cards found`
            : `${seen}/3 cards found`;
      setStatus(names);
    };
    w.addEventListener('message', onMessage);
    sendFrame(false); // the worker's first tick may have arrived before this listener existed
    return () => {
      clearTimeout(tipTimer);
      clearTimeout(frames.timer);
      if (vid && frames.supported) vid.cancelVideoFrameCallback(vfcId);
      w.removeEventListener('message', onMessage);
    };
  }, [capture, byId, heroId, heroes, onHero, hero]);

  const took = (r: RankedOffer) => {
    setOwned((o) => [...o, r.item.id]);
    setCards([]);
    if (choice < 3) setChoice(choice + 1);
    else if (round < 5) {
      setRound(round + 1);
      setChoice(1);
    }
  };
  const rerolled = () => {
    setRerollsLeft(Math.max(0, rerolls - 1));
    setCards([]);
  };
  const setCard = (k: number, id: number, enhanced: boolean) =>
    setCards((c) => {
      const n = [...c];
      while (n.length < 3) n.push({ itemId: 0 });
      n[k] = { itemId: id, enhanced };
      return n.filter((o) => o.itemId).slice(0, 3);
    });

  // Never early-return before the <video>: doing so unmounts the hidden element holding the capture
  // stream, so the worker loop stops getting frames on any hero change (loaded.heroId !== hero.id
  // reopens this loading gap until the new hero's analytics resolve). Show the loading/error state
  // inside the advice area instead.
  const onStart = () => {
    manualStopRef.current = false;
    setManualStop(false);
    setDenied(false);
    void startCapture();
  };
  const onStop = () => {
    manualStopRef.current = true;
    setManualStop(true);
    captureWantedRef.current = false;
    stopCapture();
  };
  const statusLine = (() => {
    if (platformWarning) return platformWarning;
    if (status === NO_DRAFT_STATUS && capture !== 'on') return status;
    if (status === 'Detecting…') return status;
    if (capture === 'starting') return 'Capture starting…';
    if (capture === 'on') {
      if (draftOpen) return `Draft — round ${round}, choice ${choice}`;
      return testMode.on ? 'Test mode on' : 'Capturing — no draft on screen';
    }
    if (testMode.on) return 'Test mode on';
    if (status.startsWith('capture failed')) return status;
    if (denied)
      return gameFound ? 'Capture denied — press Start to retry' : 'Deadlock window not found — press Start to retry';
    if (!isElectron) return status || 'Capture off — press Start';
    if (gameFound && f8InUse) return 'F8 is in use by another program';
    if (!gameFound) return 'Deadlock window not found';
    return manualStop ? 'Capture stopped — press Start' : 'Deadlock found, capture off';
  })();
  const advicePanel = (
    <AdvicePanel
      input={input}
      error={error}
      cards={cards}
      capture={capture}
      status={status}
      took_={took_}
      owned={owned}
      ranked={ranked}
      reroll={reroll}
      rerolls={rerolls}
      hero={hero}
      took={took}
      rerolled={rerolled}
    />
  );

  return (
    <div className="brawl">
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      <div className="panel brawl-controls">
        <div className="brawl-buttons">
          <button
            className={capture === 'off' ? 'btn primary brawl-capture' : 'btn brawl-capture'}
            onClick={capture === 'on' ? onStop : onStart}
            disabled={capture === 'starting'}
          >
            {capture === 'on' ? 'Stop capture' : capture === 'starting' ? 'Starting…' : 'Start capture'}
          </button>
          {isElectron && (
            <button
              className="btn brawl-detect"
              onClick={() => void window.brawlAPI!.detectNow()}
              disabled={!gameFound || status === 'Detecting…'}
              title={gameFound ? 'Read the game once, now (F8)' : 'Deadlock not found'}
            >
              {status === 'Detecting…' ? 'Detecting…' : 'Detect now (F8)'}
            </button>
          )}
        </div>
        {isElectron && !gameFound && <div className="muted brawl-status">Deadlock not found</div>}
        <div className="muted brawl-status" role="status" aria-live="polite">
          {statusLine}
        </div>
        {!draftSeen && (
          <div className="muted brawl-howto">
            In Deadlock, set Video → Display Mode to Borderless Windowed. Advice appears over the draft screen.
          </div>
        )}
      </div>

      {debug && (
        <div className="panel brawl-debug" aria-label="Debug panel">
          <h2>Debug</h2>
          {isElectron && (
            <div className="row brawl-testmode">
              <button
                className={testMode.on ? 'btn' : 'btn primary'}
                aria-pressed={testMode.on}
                onClick={() => void window.brawlAPI!.setTestMode(!testMode.on).then(setTestMode)}
              >
                {testMode.on ? 'Turn test mode off' : 'Test mode (dummy Deadlock window)'}
              </button>
              {testMode.on && (
                <label>
                  Screenshot{' '}
                  <select
                    aria-label="Test screenshot"
                    value={testMode.frame}
                    onChange={(e) => void window.brawlAPI!.setTestFrame(e.target.value).then(setTestMode)}
                  >
                    {testMode.frames.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {testMode.message && (
                <span className="brawl-testmode-message" role="alert">
                  {testMode.message}
                </span>
              )}
            </div>
          )}
          <div className="row">
            <label>
              Round{' '}
              <select
                aria-label="Round"
                value={round}
                onChange={(e) => {
                  setRound(Number(e.target.value));
                  setChoice(1);
                  setCards([]);
                }}
              >
                {[1, 2, 3, 4, 5].map((r) => (
                  <option key={r} value={r}>
                    {r} ({config?.gold_per_round[r - 1] ?? '…'} souls)
                  </option>
                ))}
              </select>
            </label>
            <label>
              Choice{' '}
              <select
                aria-label="Choice"
                value={choice}
                onChange={(e) => {
                  setChoice(Number(e.target.value));
                  setCards([]);
                }}
              >
                {[1, 2, 3].map((c) => (
                  <option key={c} value={c}>
                    {c} of 3{tiers[c - 1] ? ` · tier ${tiers[c - 1].normal} (rare ${tiers[c - 1].rare})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Re-rolls left{' '}
              <input
                type="number"
                min={0}
                max={3}
                value={rerolls}
                onChange={(e) => setRerollsLeft(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="row">
            {enemies.map((id, k) => (
              <select
                key={k}
                value={id}
                aria-label={`Enemy ${k + 1}`}
                onChange={(e) => setEnemies((es) => es.map((x, i) => (i === k ? Number(e.target.value) : x)))}
              >
                <option value={0}>enemy {k + 1}</option>
                {heroes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            ))}
          </div>
          {!isElectron && (
            <div className="row">
              <button className="btn" onClick={pip ? () => pip.close() : openPip}>
                {pip ? 'Close overlay' : hasDpip() ? 'Always-on-top overlay' : 'Advice window'}
              </button>
            </div>
          )}
        </div>
      )}

      {(debug || !isElectron) && (
        <>
          {pip ? (
            createPortal(
              <div className="pip">
                <h2>
                  {hero.name} · round {round}, choice {choice}
                </h2>
                {reroll && (
                  <div className="brawl-reroll-banner">
                    RE-ROLL this set — expected best {reroll.expectedBest.toFixed(2)} vs {reroll.currentBest.toFixed(2)}{' '}
                    on screen
                    <button className="btn" onClick={rerolled}>
                      I re-rolled
                    </button>
                  </div>
                )}
                {tip && <AbilityPanel panel={tip} className="ap-pip" />}
                {capture === 'on' && (
                  <canvas
                    ref={previewRef}
                    width={320}
                    height={180}
                    className="brawl-preview"
                    aria-label="Draft screen with the recommended card boxed"
                  />
                )}
                {advicePanel}
              </div>,
              pip.document.body,
            )
          ) : (
            <>
              {/* Electron already draws the box on the real game window via its own overlay; showing this
              preview here too would just duplicate it in the control window. */}
              {!isElectron && capture === 'on' && (
                <canvas
                  ref={previewRef}
                  width={320}
                  height={180}
                  className="brawl-preview"
                  aria-label="Draft screen with the recommended card boxed"
                />
              )}
              {advicePanel}
            </>
          )}

          <div className="panel">
            <h2>Cards on screen</h2>
            <div className="muted">Filled in by the capture, or pick them here. Tick "enh." for an ENHANCED card.</div>
            <div className="row">
              {[0, 1, 2].map((k) => (
                <span key={k} className="brawl-pick">
                  <select
                    value={cards[k]?.itemId ?? 0}
                    onChange={(e) => setCard(k, Number(e.target.value), !!cards[k]?.enhanced)}
                  >
                    <option value={0}>card {k + 1}</option>
                    {catalog.map((i) => (
                      <option key={i.id} value={i.id}>
                        T{i.item_tier} {i.name}
                      </option>
                    ))}
                  </select>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!cards[k]?.enhanced}
                      onChange={(e) => cards[k] && setCard(k, cards[k].itemId, e.target.checked)}
                    />{' '}
                    enh.
                  </label>
                </span>
              ))}
            </div>
          </div>

          {abilityOrder && abilityOrder.steps.length > 0 && (
            <div className="panel">
              <h2>Ability order</h2>
              {abilityOrder.support ? (
                <div className="muted">
                  seen in {abilityOrder.support.matches} brawls, wins {(abilityOrder.support.winRate * 100).toFixed(0)}%
                </div>
              ) : (
                <div className="muted">no Street Brawl ability data for {hero.name} yet; fallback order shown</div>
              )}
              {abilityTarget && <AbilityPanel panel={abilityTarget} className="ap-control" />}
              <ol className="brawl-ability-order">
                {abilityOrder.steps.map((s, k) => (
                  <li key={k} className={k === abilityStepNow ? 'now' : ''}>
                    {s.ability.name} <small>({s.kind})</small>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="panel">
            <h2>{hero.name}'s top items</h2>
            <div className="muted">Best pick in each tier, relative to the other items of that tier.</div>
            <div className="top-items">
              {topItems.map(({ tier, items }) => (
                <div key={tier} className="top-items-tier">
                  <h3>Tier {tier}</h3>
                  <div className="tiles">
                    {items.map((b, k) => (
                      <ItemTile key={b.item.id} item={b.item} order={k + 1} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h2>Owned ({owned.length})</h2>
            <div className="muted">
              {capture === 'on'
                ? 'Read from the inventory grid on the draft screen; tap to remove a mistake.'
                : 'Tap a card above when you take it; tap here to remove a mistake.'}
            </div>
            <div className="chips">
              {owned.map((id, k) => (
                <button key={k} className="chip" onClick={() => setOwned((o) => o.filter((_, i) => i !== k))}>
                  {byId.get(id)?.name}
                </button>
              ))}
            </div>
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  setOwned([]);
                  setCards([]);
                  setTook('');
                  offeredRef.current = new Set();
                  setRound(1);
                  setChoice(1);
                  setEnemies(Array<number>(ENEMY_SLOTS).fill(0));
                }}
              >
                New game
              </button>
            </div>
          </div>
        </>
      )}
      {debug && (
        <div className="muted brawl-foot">
          <img src={img(hero.images.small)} alt="" /> Layout anchors are for 2560×1440; other 16:9 sizes scale. The
          capture only reads pixels. Run Deadlock in borderless windowed mode so the overlay stays on top of it
          (Chrome/Edge).
        </div>
      )}
    </div>
  );
}

const toOffer = (r: CardRead): Offer => ({ itemId: r.itemId, enhanced: r.enhanced });

interface AdvicePanelProps {
  input: BrawlInput | null;
  error: string | null;
  cards: Offer[];
  capture: 'off' | 'starting' | 'on';
  status: string;
  took_: string;
  owned: number[];
  ranked: RankedOffer[];
  reroll: RerollAdvice | null;
  rerolls: number;
  hero: Hero;
  took: (r: RankedOffer) => void;
  rerolled: () => void;
}

/** Split out so the loading/error state (shown while `input` is null, e.g. right after a hero change)
 *  never has to gate what renders above it in BrawlView — see the "never early-return before <video>" note. */
function AdvicePanel({
  input,
  error,
  cards,
  capture,
  status,
  took_,
  owned,
  ranked,
  reroll,
  rerolls,
  hero,
  took,
  rerolled,
}: AdvicePanelProps) {
  if (!input) {
    return (
      <div className="brawl-advice">
        {error ? <div className="error">{error}</div> : <div className="loading">Loading Street Brawl data…</div>}
      </div>
    );
  }
  return (
    <div className="brawl-advice">
      {reroll && (
        <div className="brawl-reroll-banner">
          RE-ROLL this set — expected best {reroll.expectedBest.toFixed(2)} vs {reroll.currentBest.toFixed(2)} on screen
          <button className="btn" onClick={rerolled}>
            I re-rolled
          </button>
        </div>
      )}
      {!cards.length && (
        <div className="muted">
          {capture === 'on'
            ? status
            : 'No cards yet. Start the screen capture above, or pick the three cards yourself in "Cards on screen" below.'}
        </div>
      )}
      {took_ && (
        <div className="muted">
          Took {took_} · {owned.length} owned
        </div>
      )}
      {ranked.map((r, k) => (
        <button
          key={r.item.id}
          className={`brawl-card ${k === 0 && !reroll ? 'best' : ''}`}
          onClick={() => took(r)}
          title={`score ${r.score.toFixed(2)} · ${
            capture === 'on' ? 'picks are read from the inventory grid; click only if it missed' : 'I took this one'
          }`}
        >
          <ItemTile item={r.item} />
          <span className="brawl-card-body">
            <b>
              {k === 0 && !reroll ? 'TAKE' : `#${k + 1}`} {r.item.name}
              {r.enhanced ? ' (enhanced)' : ''}
            </b>
            <small>
              score {r.score.toFixed(2)} ·{' '}
              {k === 0 ? 'best' : `−${((1 - r.score / ranked[0].score) * 100).toFixed(0)}% vs best`} · used by{' '}
              {(r.usage * 100).toFixed(0)}% of {hero.name}s
              {r.winRate !== null ? `, wins ${(r.winRate * 100).toFixed(0)}%` : ''}
              {r.known ? '' : ' · no brawl data'}
            </small>
            {r.why.length > 0 && <small>{r.why.join('; ')}</small>}
          </span>
        </button>
      ))}
      {reroll && reroll.holdValue > 0 && (
        <div className="muted">saving this set for a later choice is worth {reroll.holdValue.toFixed(2)}</div>
      )}
      {cards.length > 0 && !reroll && <div className="muted">Keep this set{rerolls ? '' : ' (no re-rolls left)'}.</div>}
    </div>
  );
}
