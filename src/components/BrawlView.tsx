import { DraftFrameGate } from '../local/draftFrameGate';
import { availableReroll, DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from '../local/overlaySettings';
import { AbilityPointsReader, abilityPointsRect } from '../local/abilityPointsReader';
import { stopItemNameOCR } from '../local/cardNameOcr';
import { AbilityTipPolicy } from '../local/abilityTipPolicy';
import { MatchMemory } from '../local/matchMemory';
import { LocalOfferJournal, offerPatch, journalCards, type OfferContext } from '../local/offerJournal';
import { adviceConfidence } from '../local/adviceConfidence';
import { teamWinRate, type TeamRoster } from '../local/teamWinRate';
import type { OfferObservation } from '../local/dropDistribution';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emptyStable, stabilise, type StableState } from '../brawl/stabilise';
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
import { AdvicePanel } from './AdvicePanel';
import { HeroReference } from '../local/HeroReference';
import { log } from '../log';
import { usePersisted, isNumber } from '../hooks/usePersisted';

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
  overlaySettings?: OverlaySettings;
}

/** Street Brawl draft advisor: the three cards on screen (read from a screen capture or typed in), ranked for this hero. */
export function BrawlView({
  hero,
  heroes,
  items,
  abilities,
  onHero,
  debug = false,
  overlaySettings = DEFAULT_OVERLAY_SETTINGS,
}: Props) {
  const settingsRef = useRef(overlaySettings);
  settingsRef.current = overlaySettings;
  const allocatedRef = useRef(0);
  const pointPolicyRef = useRef(new AbilityTipPolicy());
  const tipModeRef = useRef(overlaySettings.abilityTipMode);
  const [loaded, setLoaded] = useState<{ heroId: number; analytics: BrawlAnalytics } | null>(null);
  const [config, setConfig] = useState<BrawlConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = usePersisted('round', isNumber, 1);
  const [choice, setChoice] = useState(1);
  const [rerollsLeft, setRerollsLeft] = useState<number | null>(null); // null: unread, conservatively treated as zero
  const [enemies, setEnemies] = useState<number[]>(Array(ENEMY_SLOTS).fill(0));
  const matchMemoryRef = useRef(new MatchMemory());
  const journalRef = useRef<LocalOfferJournal | null>(null);
  if (!journalRef.current) {
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* Advice works when storage is disabled. */
    }
    journalRef.current = new LocalOfferJournal(storage);
  }
  const pendingOfferRef = useRef<{
    context: OfferContext;
    cards: OfferObservation['cards'];
    generation: OfferObservation['generation'] | null;
    count: number | null;
    initialCount: number;
    observedAt: number;
  } | null>(null);
  const lastOfferLabelRef = useRef('');
  const nextRerollLabelRef = useRef('');
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
  const lastReadSigRef = useRef('');
  const unreadFramesRef = useRef(0);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
    workerIndexRef.current.names ??= Object.fromEntries(
      items.filter((i) => !i.disabled && i.item_tier >= 1).map((i) => [i.id, i.name]),
    );
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
  const stableRef = useRef<StableState>(emptyStable());
  const readsRef = useRef<CardRead[]>([]); // latest card positions on screen, for the preview highlight
  const acceptedKeyRef = useRef(''); // last accepted card-set key, to discard a stale async 'rerolls' OCR result
  const rankedRef = useRef<RankedOffer[]>([]);
  const rerollRef = useRef<RerollAdvice | null>(null);
  const overlayAdviceRef = useRef<OverlayAdvice | null>(null);
  // Tier-list letter per item (S/A/B/C), shown in the badge on each plate.
  const [tierData, setTierData] = useState<BrawlTierListData | null>(null);
  const teamRosterRef = useRef<TeamRoster | null>(null);
  const teamEdgeRef = useRef<ReturnType<typeof teamWinRate>>(null);
  const tierDataRef = useRef(tierData);
  tierDataRef.current = tierData;
  teamEdgeRef.current = teamWinRate(teamRosterRef.current, tierData, heroes);
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
    matchMemoryRef.current.setManualOwned(owned);
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
  const offerPatchRef = useRef<string | null>(null);
  offerPatchRef.current = offerPatch(analytics?.stats_window);
  const configRef = useRef(config);
  configRef.current = config;
  const testModeRef = useRef(false);
  const flushJournal = () => {
    const pending = pendingOfferRef.current;
    if (!pending || !matchMemoryRef.current.rosterStable || testModeRef.current || window.brawlAPI?.isE2E) return;
    const generation = pending.generation ?? (pending.count === pending.initialCount ? 'initial' : null);
    // Attaching in the middle of a choice cannot establish whether its first visible set was rerolled.
    if (!generation) return;
    journalRef.current?.recordAccepted(pending.context, pending.cards, generation, pending.observedAt);
    pendingOfferRef.current = null;
  };
  const rerolls = rerollsLeft ?? 0;

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
  const enemyIds = useMemo(() => enemies.filter(Boolean), [enemies]);
  const heroId = hero.id;
  const advice = useMemo(() => {
    if (!input || cards.length < 3) return null; // advise only once all 3 cards are read
    const sets: Offer[][] = [[], [], []];
    sets[choice - 1] = cards;
    return adviseDraft(input, { round, choice, rerollsRemaining: rerollsLeft, owned, enemies: enemyIds, sets });
  }, [input, cards, round, owned, choice, enemyIds, rerollsLeft]);
  const ranked: RankedOffer[] = useMemo(() => advice?.sets[choice - 1] ?? [], [advice, choice]);
  useEffect(() => {
    rankedRef.current = ranked;
  }, [ranked]);
  const reroll = availableReroll(advice?.reroll, rerollsLeft);
  const confidence = input ? adviceConfidence(input, ranked, reroll, round) : '';
  useEffect(() => {
    rerollRef.current = reroll;
  }, [reroll]);
  const tiers = input ? roundTiers(input, round) : [];
  const topItems = useMemo(() => (input ? topItemsByTier(input) : []), [input]);
  const abilityOrder = useMemo(() => (input ? brawlAbilityOrder(input) : null), [input]);
  allocatedRef.current = (config?.apper_round ?? [6, 6, 5, 5, 10])
    .slice(0, round)
    .reduce((sum, points) => sum + points, 0);
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
        teamEdge:
          draft && roundRef.current === 1 && settingsRef.current.showTeamWinRates !== false
            ? teamEdgeRef.current
            : null,
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
    overlayAdviceRef.current =
      input && ranked.length === 3
        ? {
            hero: hero.name,
            detail: overlaySettings.detail,
            rerollsRemaining: rerollsLeft,
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
            confidence,
          }
        : null;
    draftRef.current = draftOpen;
    tipRef.current = tip;
    pushOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pushOverlay only reads refs
  }, [
    input,
    hero,
    round,
    choice,
    reroll,
    ranked,
    draftOpen,
    tip,
    status,
    gradeById,
    rerollsLeft,
    overlaySettings,
    confidence,
    tierData,
  ]);

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
    log('brawl-view', 'info', 'detect.run', {
      ignored: !isElectron || !!detectRef.current,
      capture: captureStateRef.current,
      draft: !!draftRef.current,
      worker: !!workerRef.current,
    });
    if (!isElectron) return;
    // a new press restarts everything, even while an earlier try is still running
    if (detectRef.current) clearTimeout(detectRef.current.timer);
    detectRef.current = null;
    cardsRef.current = [];
    prevCardsRef.current = [];
    acceptedKeyRef.current = '';
    setRerollsLeft(null);
    unreadFramesRef.current = 0;
    lastReadSigRef.current = '';
    setCards([]);
    setRerollsLeft(null);
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
    setTimeout(() => {
      const fc = fullCanvasRef.current;
      if (fc && fc.width) window.brawlAPI?.saveDebugFrame?.(fc.toDataURL('image/png'));
    }, 1500);
    // throw every old read away and start a fresh capture + worker, whatever state capture was in
    manualStopRef.current = false;
    setManualStop(false);
    setDenied(false);
    if (captureStateRef.current !== 'off') stopCapture();
    void startCapture();
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
    teamRosterRef.current = null;
    teamEdgeRef.current = null;
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
      if (!detectRef.current) setStatus('loading icon index…');
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
      if (!detectRef.current) setStatus('watching for the draft screen');
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
  testModeRef.current = testMode.on;
  useEffect(() => {
    if (!isElectron) return;
    const api = window.brawlAPI!;
    void api.getTestMode().then(setTestMode);
    return api.onTestMode(setTestMode);
  }, []);
  useEffect(() => {
    // Selecting a test screenshot is an explicit new observation session, including backward fixture labels.
    if (testMode.on) workerRef.current?.postMessage({ type: 'reset' } satisfies WorkerIn);
  }, [testMode.on, testMode.frame]);

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
    const frameGate = new DraftFrameGate();
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
    const pointsReader = new AbilityPointsReader();
    const pointPolicy = pointPolicyRef.current;
    let disposed = false;
    let hudCanvas: HTMLCanvasElement | null = null;
    const usesPoints = () => tipModeRef.current === 'points';
    const armTip = () => {
      const current = tipStateRef.current;
      tipRef.current = current.tip?.value ?? null;
      setTip(current.tip?.value ?? null);
      clearTimeout(tipTimer);
      if (current.tip)
        tipTimer = setTimeout(() => stepTracker(false), Math.max(0, current.tip.endsAt - Date.now()) + 5);
      pushOverlay();
    };
    // Feeds the debounced draft/tip tracker one frame result, and (re)arms the timer that ends the tip on its own.
    const stepTracker = (shop: boolean) => {
      const now = Date.now();
      const testMs = window.brawlAPI?.isE2E ? window.brawlAPI.tipMs : undefined;
      const tipMs = testMs ?? settingsRef.current.tipSeconds * 1000;
      const previous = tipStateRef.current;
      const next = stepTip(previous, shop, now, abilityTargetRef.current, tipMs);
      if (next.tip && !previous.tip) {
        pointsReader.reset();
        tipModeRef.current = settingsRef.current.abilityTipMode;
        pointPolicy.begin(now, testMs ?? settingsRef.current.pointLimitSeconds * 1000, allocatedRef.current);
      }
      if (shop) pointsReader.reset();
      tipStateRef.current = next;
      draftRef.current = next.draft;
      setDraftOpen(next.draft);
      armTip();
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
      if (usesPoints() && tipStateRef.current.tip) {
        const rect = abilityPointsRect(srcW, srcH);
        hudCanvas ??= document.createElement('canvas');
        if (hudCanvas.width !== rect.width) hudCanvas.width = rect.width;
        if (hudCanvas.height !== rect.height) hudCanvas.height = rect.height;
        const ctx = hudCanvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(src, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        const image = ctx.getImageData(0, 0, rect.width, rect.height);
        pointsReader.poll(
          { width: rect.width, height: rect.height, data: image.data, channels: 4 },
          performance.now(),
          (points) => {
            if (disposed || !usesPoints() || !tipStateRef.current.tip || draftRef.current) return;
            const tip = tipStateRef.current.tip;
            const end = pointPolicy.update(points, tip.endsAt);
            tipStateRef.current = {
              ...tipStateRef.current,
              tip:
                end === null
                  ? null
                  : {
                      endsAt: end,
                      value: { ...tip.value, availablePoints: typeof points === 'number' ? points : null },
                    },
            };
            log('brawl-view', 'info', 'ability.points', { points, visible: end !== null });
            armTip();
          },
        );
      }
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
        const applied =
          ev.data.forKey === acceptedKeyRef.current &&
          ev.data.forChoice === choiceRef.current &&
          (ev.data.forRound === 0 || ev.data.forRound === roundRef.current);
        log('brawl-view', 'info', 'rerolls.read', { value: ev.data.rerollsRemaining, applied });
        if (applied) {
          const label = `${roundRef.current}:${choiceRef.current}`;
          if (ev.data.spent) {
            nextRerollLabelRef.current = label;
            const pending = pendingOfferRef.current;
            if (pending) journalRef.current?.markReroll(pending.context);
          } else if (
            pendingOfferRef.current &&
            `${pendingOfferRef.current.context.round}:${pendingOfferRef.current.context.choice}` === label
          ) {
            pendingOfferRef.current.count = ev.data.rerollsRemaining >= 0 ? ev.data.rerollsRemaining : null;
            flushJournal();
          }
          if (ev.data.spent) {
            frameGate.invalidate();
            acceptedKeyRef.current = '';
            prevCardsRef.current = cardsRef.current;
            cardsRef.current = [];
            rankedRef.current = [];
            overlayAdviceRef.current = null;
            readsRef.current = [];
            stableRef.current = emptyStable();
            setCards([]);
          }
          setRerollsLeft(ev.data.rerollsRemaining >= 0 ? ev.data.rerollsRemaining : null);
          if (overlayAdviceRef.current)
            overlayAdviceRef.current = {
              ...overlayAdviceRef.current,
              rerollsRemaining: ev.data.rerollsRemaining >= 0 ? ev.data.rerollsRemaining : null,
            };
          if (ev.data.rerollsRemaining <= 0) {
            rerollRef.current = null;
            if (overlayAdviceRef.current) overlayAdviceRef.current = { ...overlayAdviceRef.current, reroll: null };
          }
          pushOverlay();
        }
        return;
      }
      const r = ev.data;
      // Game evidence is independent of whether a tooltip currently hides the offered cards.
      if (r.meta?.self && frameGate.acceptsContext(r)) {
        const memory = matchMemoryRef.current;
        const established = memory.enemies.length === ENEMY_SLOTS;
        const observed = memory.observeRoster(r.meta.self, enemiesFrom(r.meta.bar, r.meta.self), r.round);
        if (observed.newMatch) {
          teamRosterRef.current = null;
          teamEdgeRef.current = null;
          ownedRef.current = [...memory.owned];
          setOwned([...memory.owned]);
          setEnemies([...memory.enemies]);
          offeredRef.current.clear();
          for (const card of r.reads) if (card.present) offeredRef.current.add(card.itemId);
          prevCardsRef.current = [];
          setTook('');
          if (established) {
            journalRef.current?.startSession();
            lastOfferLabelRef.current = '';
            nextRerollLabelRef.current = '';
          }
          log('brawl-view', 'info', 'match.confirmed', { self: r.meta.self, enemies: memory.enemies });
        }
      }
      if (r.inventory !== null) {
        const before = ownedRef.current;
        const { owned: after, gained } = matchMemoryRef.current.observeInventory(r.inventory, items, Date.now());
        const pick = gained.find((id) => [...prevCardsRef.current, ...cardsRef.current].some((c) => c.itemId === id));
        if (pick) setTook(byId.get(pick)?.name ?? '');
        if (after.length !== before.length || after.some((id, i) => id !== before[i])) {
          ownedRef.current = after;
          setOwned(after);
        }
      }
      if (r.pendingTransition) {
        frameGate.invalidate();
        prevCardsRef.current = cardsRef.current.length ? cardsRef.current : prevCardsRef.current;
        cardsRef.current = [];
        readsRef.current = [];
        stableRef.current = emptyStable();
        rankedRef.current = [];
        rerollRef.current = null;
        overlayAdviceRef.current = null;
        pendingOfferRef.current = null;
        setCards([]);
        pushOverlay();
        return;
      }
      if (!frameGate.publish(r, performance.now())) return;
      if (r.teamRoster && r.shop) {
        teamRosterRef.current = r.teamRoster;
        teamEdgeRef.current = teamWinRate(r.teamRoster, tierDataRef.current, heroes);
      }
      if (!r.shop) {
        // The item panel closes after the short screen debounce; the ability tip has its own longer debounce.
        prevCardsRef.current = cardsRef.current.length ? cardsRef.current : prevCardsRef.current;
        cardsRef.current = [];
        readsRef.current = [];
        stableRef.current = emptyStable();
        acceptedKeyRef.current = '';
        rankedRef.current = [];
        rerollRef.current = null;
        overlayAdviceRef.current = null;
        pendingOfferRef.current = null;
        teamRosterRef.current = null;
        teamEdgeRef.current = null;
        setCards([]);
        pushOverlay();
      }
      if (perf.enabled) {
        perf.record(r.shop ? 'worker.draft' : 'worker.probe', r.ms);
        for (const [k, v] of Object.entries(r.stages ?? {})) perf.record(`worker.${k}`, v);
      }
      stableRef.current = r.shop ? stabilise(stableRef.current, r.reads) : emptyStable();
      readsRef.current = stableRef.current.reads;
      const seen = r.reads.filter((x) => x.present).length;
      if (r.accepted) {
        const previousRound = roundRef.current;
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
        const patch = offerPatchRef.current;
        const layout = configRef.current?.item_draft_rounds_per_game_round[roundRef.current - 1]?.item_draft_rounds;
        const label = `${roundRef.current}:${choiceRef.current}`;
        if (
          r.transition !== 'reacquire' &&
          r.transition !== 'metadata' &&
          patch &&
          meta.self &&
          layout &&
          !testModeRef.current &&
          !window.brawlAPI?.isE2E
        ) {
          const offerCards = journalCards(offers, byId, layout[choiceRef.current - 1]);
          if (offerCards) {
            const generation =
              r.transition === 'reroll' || nextRerollLabelRef.current === label
                ? 'reroll'
                : lastOfferLabelRef.current && lastOfferLabelRef.current !== label
                  ? 'initial'
                  : null;
            const context = { patch, heroId: meta.self, round: roundRef.current, choice: choiceRef.current };
            if (generation === 'reroll') journalRef.current?.markReroll(context);
            pendingOfferRef.current = {
              context,
              cards: offerCards,
              generation,
              count: meta.rerollsRemaining >= 0 ? meta.rerollsRemaining : null,
              initialCount: configRef.current!.item_draft_rerolls_per_round[roundRef.current - 1] ?? 0,
              observedAt: Date.now(),
            };
            nextRerollLabelRef.current = '';
            lastOfferLabelRef.current = label;
          }
        }
        acceptedKeyRef.current = r.key;
        // read straight off the "N Re-Roll Remaining" caption instead of inferring a re-roll from a changed
        // card set, so a stale reroll suggestion clears the moment the game's own counter does. 0 here means
        // no glyph at all (confidently zero); -1 means a glyph is showing and the real OCR read (see
        // ocr.ts's readRerollsRemaining) is still pending -- leave the current value alone until the
        // worker's follow-up 'rerolls' message resolves it, rather than overwrite a real count with "unread".
        setRerollsLeft((previous) =>
          meta.rerollsRemaining >= 0 ? meta.rerollsRemaining : roundRef.current !== previousRound ? null : previous,
        );
        // the square-topped portrait is the player's: switch the app's hero to it (the enemies are then the other side)
        if (!meta.self) {
          log('brawl-view', 'debug', 'hero.detect.miss', { bar: meta.bar });
        }
        const me = meta.self && heroes.some((h) => h.id === meta.self) ? meta.self : heroId;
        if (me !== heroId) {
          const score = [...meta.bar.left, ...meta.bar.right].find((m) => m.heroId === me)?.score;
          log('brawl-view', 'info', 'hero.detect', { from: heroId, to: me, score });
          onHero(me, 'detected');
        }
      }
      flushJournal();
      if (!r.shop) {
        readsRef.current = [];
        const pv = previewRef.current;
        pv?.getContext('2d')?.clearRect(0, 0, pv.width, pv.height);
      }
      const readSig = `${r.shop}|${seen}|${r.round}|${r.choice}|${r.accepted}|${r.reads.map((x) => x.itemId).join(',')}`;
      if (readSig !== lastReadSigRef.current) {
        lastReadSigRef.current = readSig;
        log('brawl-view', 'info', 'draft.read', {
          shop: r.shop,
          seen,
          round: r.round,
          choice: r.choice,
          accepted: r.accepted,
          items: r.reads.map((x) => x.itemId),
        });
      }
      setFps(r.shop);
      stepTracker(r.shop);
      if (detectRef.current) {
        if (r.shop) finishDetect('hit');
        else if (++detectMissesRef.current < DETECT_MISSES) {
          return;
        } else {
          // report it, but keep watching: the draft may simply not be open yet
          finishDetect('miss');
          setStatus(NO_DRAFT_STATUS);
          return;
        }
      }
      const heroDetected = r.accepted && r.meta!.self && r.meta!.self === heroId;
      const hidden = r.shop && seen < 3 ? ' · move the mouse off the cards' : '';
      const names = !r.shop
        ? 'waiting for the shop'
        : seen === 3
          ? r.reads.map((x) => byId.get(x.itemId)?.name ?? '?').join(' / ')
          : heroDetected
            ? `hero: ${hero.name} · ${seen}/3 cards found${hidden}`
            : `${seen}/3 cards found${hidden}`;
      setStatus((previous) => (!r.shop && previous === NO_DRAFT_STATUS ? previous : names));
    };
    w.addEventListener('message', onMessage);
    sendFrame(false); // the worker's first tick may have arrived before this listener existed
    return () => {
      disposed = true;
      pointsReader.reset();
      void stopItemNameOCR();
      clearTimeout(tipTimer);
      clearTimeout(frames.timer);
      if (vid && frames.supported) vid.cancelVideoFrameCallback(vfcId);
      w.removeEventListener('message', onMessage);
    };
  }, [capture, byId, heroId, heroes, onHero, hero, items, setRound, setEnemies]);

  const took = (r: RankedOffer) => {
    const acquired = matchMemoryRef.current.observeInventory([r.item.id], items, Date.now()).owned;
    ownedRef.current = [...acquired];
    setOwned([...acquired]);
    setTook(r.item.name);
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
    if (status === NO_DRAFT_STATUS) return status;
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
      lastTaken={took_}
      owned={owned}
      ranked={ranked}
      confidence={confidence}
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

      <HeroReference
        hero={hero}
        topItems={topItems}
        abilityOrder={abilityOrder}
        abilityTarget={abilityTarget}
        abilityStepNow={abilityStepNow}
      />

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
                  matchMemoryRef.current.reset();
                  journalRef.current?.startSession();
                  pendingOfferRef.current = null;
                  lastOfferLabelRef.current = nextRerollLabelRef.current = '';
                  ownedRef.current = [];
                  prevCardsRef.current = [];
                  setRerollsLeft(null);
                  workerRef.current?.postMessage({ type: 'reset' } satisfies WorkerIn);
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
