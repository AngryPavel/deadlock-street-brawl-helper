// Web Worker that runs the Street Brawl screen recogniser off the main thread, so the page and the overlay stay
// responsive while frames are read. It keeps the small amount of state needed to decide when a screen is "new":
// complete card/label tuples are committed after transition evidence, and expensive hero-bar reads are cached.
import {
  HERO_BAR,
  cardAnchors,
  enemiesFrom,
  inventoryRegions,
  decodeIconIndex,
  isShopScreen,
  readDraftMeta,
  readRoundChoice,
  readPlayerHero,
  readDraftScreen,
  readInventory,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
} from './recognise';
import { terminateOCR, warmOCR } from './ocr';
import { RerollCounterReader } from '../local/rerollCounter';
import { hudLayout } from '../local/hudLayout';
import { CardNameRecovery, serialFrames } from '../local/cardRecognition';
import { stopItemNameOCR } from '../local/cardNameOcr';
import { InventoryConfirmation } from '../local/inventoryConfirmation';
import { DraftOfferLock } from '../local/draftOfferLock';
import { CardNameConfirmation, strongDirectCard } from '../local/cardNameConfirmation';
import { completedItemStatus, readingItemStatus, type ItemReadStatus } from '../local/itemReadStatus';
import { cardNameRegions, hasItemNameInk } from '../local/cardNames';
import { SelfHeroConfirmation } from '../local/selfHeroConfirmation';
import { TeamRosterConfirmation, type TeamRoster } from '../local/teamWinRate';
import { FirstRoundPreparation, hasRoundCountdown } from '../local/firstRoundPreparation';
import type { IconIndex } from './types';

export interface FrameRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type WorkerIn =
  | { type: 'warm'; index: IconIndex; tiers: Record<number, number> }
  | { type: 'init'; index: IconIndex; tiers: Record<number, number>; intervalMs: number; captureEpoch?: number }
  // A draft frame is only the rectangles the recogniser reads (draftRegions), each with its own pixels: the worker
  // pastes them into a reused frame-sized buffer, so nothing outside them is ever copied out of the video.
  | { type: 'frame'; captureEpoch?: number; width: number; height: number; regions: FrameRegion[]; prefer: number[] }
  // Off the draft screen the page copies just the "CHOICE n OF 3" crop (see shopProbeRect) instead of a whole frame.
  | {
      type: 'probe';
      captureEpoch?: number;
      frameW: number;
      frameH: number;
      x: number;
      y: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | { type: 'idle' } // the page had no frame ready for the last tick
  | { type: 'reset'; captureEpoch?: number } // capture (re)started: forget the last draft and start ticking again
  | { type: 'stop' }; // capture stopped: forget the last draft and free the OCR engine; the worker then stays silent

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'tick'; full: boolean; captureEpoch?: number } // full: send a whole frame; otherwise just the probe crop
  | {
      type: 'rerolls';
      captureEpoch?: number;
      forKey: string;
      forRound: number;
      forChoice: number;
      rerollsRemaining: number;
      spent: boolean;
    };

export interface FrameResult {
  /** Confirmed player metadata published before item qualification, with no offer acceptance. */
  identityOnly?: boolean;
  /** Fresh capture identity for roster confirmation; multiple results from one frame share it. */
  metadataSample?: number;
  /** Fixed preparation caption evidence, independent of whether the item draft is open. */
  roundCountdown?: boolean;
  /** Actual top ROUND glyph, also read on a non-shop preparation frame. */
  preparationRound?: number;
  /** Distinct full capture sample, so repeated delivery cannot confirm a contradictory ROUND glyph. */
  preparationSample?: number;
  captureEpoch?: number;
  teamRoster?: TeamRoster | null;
  transition?: 'initial' | 'choice' | 'round' | 'reroll' | 'metadata' | 'reacquire' | 'hero';
  pendingTransition?: boolean;
  pending?: boolean;
  /** Current candidate progress only; contains no tentative IDs or recommendations. */
  itemReadStatus?: ItemReadStatus;
  type: 'result';
  shop: boolean; // visible draft labels or unchanged known card pixels; false skips card/inventory recognition
  round: number; // committed ROUND / CHOICE labels once established (0: unread; 0 on a non-draft frame)
  choice: number;
  reads: CardRead[];
  key: string; // item ids of the three cards, '' when fewer than three are visible
  accepted: boolean; // true when the transition lock commits a tuple or confirmed metadata recovers
  meta: DraftMeta | null; // stable round / choice / hero bar, retained while the same draft is visible
  inventory: number[] | null; // owned items from the inventory grid, once two consecutive reads agree; null otherwise
  ms: number;
  stages?: Record<string, number>; // dev builds only: milliseconds per recogniser stage
}

let index: DecodedIndex | null = null;
let tiers: Record<number, number> = {};
let lastKey = '',
  acceptedKey = '';
const inventoryConfirmation = new InventoryConfirmation();
const offerLock = new DraftOfferLock();
const teamRoster = new TeamRosterConfirmation();
const preparation = new FirstRoundPreparation();
let frameCountdown = false;
let preparationRound = 0;
let preparationSample = 0;
const selfHeroConfirmation = new SelfHeroConfirmation();
let lastRosterReadFrame = -1;
let nextTeamRetryAt = 0;
let pendingPreparationCorrection = false;
let pendingIdentityMeta: { frame: number; readAt: number; replayInventory: boolean } | null = null;
let freshMetaCache: { frame: number; round: number; meta: DraftMeta } | null = null;
let offerEpoch = 0;
let captureEpoch = 0;
let closedSince: number | null = null;
let committedCardSigs: Uint8Array[] = [];
let pendingCardSigs: Uint8Array[] = [];
let visualEpoch = 0;
let pendingDirect = false;
let pendingNames = false;
let pendingStrong: boolean[] = [];
let candidateCardSigs: Uint8Array[] = [];
let candidateCardKey = '';
let awaitingNames = false;
let captureSequence = 0;
let previousInventory: number[] = [];
let inventoryPick = false;
let settledMeta: DraftMeta | null = null;
let settledBarSig: Uint8Array | null = null;
let nextMetaRetryAt = 0;
let rosterInventoryReplayed = false;
const completeRoster = (meta: DraftMeta | null) => !!meta?.self && new Set(enemiesFrom(meta.bar, meta.self)).size === 4;
const completeMetadata = (meta: DraftMeta | null) =>
  completeRoster(meta) && (acceptedRound !== 1 || teamRoster.complete);
const rerollCounter = new RerollCounterReader();
const recovery = new CardNameRecovery();
const nameConfirmation = new CardNameConfirmation();
let names: Record<string, string> = {};
function pollRerolls(img: Parameters<RerollCounterReader['poll']>[0]) {
  rerollCounter.poll(
    img,
    {
      key: acceptedKey,
      round: offerLock.pendingLabels?.round ?? acceptedRound,
      choice: offerLock.pendingLabels?.choice ?? acceptedChoice,
    },
    performance.now(),
    (rerollsRemaining, ctx, spent) => {
      if (spent) {
        offerEpoch++;
        offerLock.armReroll();
        lastKey = '';
        pendingReads = [];
        pendingCardSigs = [];
        pendingNames = false;
        candidateCardSigs = [];
        candidateCardKey = '';
        awaitingNames = false;
        nameConfirmation.reset();
        settledSig = pendingSig = null;
      }
      post({ type: 'rerolls', forKey: ctx.key, forRound: ctx.round, forChoice: ctx.choice, rerollsRemaining, spent });
    },
  );
}
let intervalMs = 250;
// Off the shop screen there's nothing to react to quickly -- poll much slower, and only read the small
// "CHOICE n OF 3" crop, until the shop reappears.
const IDLE_INTERVAL_MS = 300;
// Once the draft screen's cards, round and choice are all settled, only a change matters: look less often.
const SETTLED_INTERVAL_MS = 100;
// While the cards are settled, a frame that looks the same (coarse pixel grid, same round/choice labels) skips the
// expensive card and inventory reads and reuses the last result: a change is noticed within one interval and the
// idle draft screen costs almost nothing.
const SIG_STEP = 16;
const SIG_CHANGED_SAMPLES = 12; // sampled channel values that moved by more than 24 (of 255) mean "changed"
let settledSig: Uint8Array | null = null;
let knownHero: { bar: DraftMeta['bar']; self: number } | null = null;
let settledReads: CardRead[] = [];
let pendingSig: Uint8Array | null = null,
  pendingReads: CardRead[] = [],
  pendingChoice = 0;
// Samples a coarse grid inside each region (not the whole frame: the rest was never copied).
const frameSig = (regions: FrameRegion[], inventory: ReturnType<typeof inventoryRegions>): Uint8Array => {
  const out: number[] = [];
  for (const r of regions) {
    if (inventory.some((i) => i.x === r.x && i.y === r.y && i.width === r.width && i.height === r.height)) continue;
    const d = new Uint8ClampedArray(r.buffer);
    for (let y = 0; y < r.height; y += SIG_STEP)
      for (let x = 0; x < r.width; x += SIG_STEP) {
        const i = (y * r.width + x) * 4;
        out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      }
  }
  return Uint8Array.from(out);
};
const inventorySignature = (img: ReturnType<typeof pasteRegions>, regions: ReturnType<typeof inventoryRegions>) => {
  let hash = 2166136261;
  for (const r of regions)
    for (let y = r.y; y < r.y + r.height; y += 4)
      for (let x = r.x; x < r.x + r.width; x += 4) {
        const i = (y * img.width + x) * 4;
        for (let c = 0; c < 3; c++) hash = Math.imul(hash ^ img.data[i + c]!, 16777619);
      }
  return `${img.width}:${img.height}:${hash >>> 0}`;
};
// Reused across frames (same regions every time, so nothing stale survives); reallocated when the frame size changes.
const cardSignatures = (img: ReturnType<typeof pasteRegions>) =>
  cardAnchors(img.width, img.height).map((a) => {
    const samples: number[] = [];
    for (let y = -0.35; y <= 0.35; y += 0.1)
      for (let x = -0.35; x <= 0.35; x += 0.1) {
        const i = (Math.round(a.cy + y * a.icon) * img.width + Math.round(a.cx + x * a.icon)) * 4;
        samples.push(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      }
    return Uint8Array.from(samples);
  });
const hasCardTexture = (sig: Uint8Array) => {
  let sum = 0,
    squares = 0;
  for (let i = 0; i < sig.length; i += 3) {
    const lum = 0.299 * sig[i]! + 0.587 * sig[i + 1]! + 0.114 * sig[i + 2]!;
    sum += lum;
    squares += lum * lum;
  }
  const n = sig.length / 3;
  return Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) > 15;
};
let frameBuf = new Uint8ClampedArray(0);
const pasteRegions = (width: number, height: number, regions: FrameRegion[]) => {
  if (frameBuf.length !== width * height * 4) frameBuf = new Uint8ClampedArray(width * height * 4);
  for (const r of regions) {
    const src = new Uint8ClampedArray(r.buffer);
    for (let y = 0; y < r.height; y++)
      frameBuf.set(src.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((r.y + y) * width + r.x) * 4);
  }
  return { width, height, data: frameBuf, channels: 4 as const };
};
const sameSig = (a: Uint8Array | null, b: Uint8Array): boolean => {
  if (!a || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 24 && ++changed >= SIG_CHANGED_SAMPLES) return false;
  return true;
};
let wasShop = false; // the previous result was a draft frame: the next non-draft frame is re-checked quickly
let acceptedRound = 0,
  acceptedChoice = 0;
let previousBarSig: Uint8Array | null = null;
let previousRound = 0;

const forgetDraft = () => {
  preparation.reset();
  frameCountdown = false;
  preparationRound = 0;
  preparationSample = 0;
  lastKey = acceptedKey = '';
  offerEpoch++;
  offerLock.reset();
  teamRoster.reset();
  committedCardSigs = [];
  pendingCardSigs = [];
  closedSince = null;
  previousInventory = [];
  inventoryPick = false;
  inventoryConfirmation.reset();
  settledMeta = null;
  settledBarSig = null;
  nextMetaRetryAt = 0;
  rerollCounter.reset();
  recovery.reset();
  nameConfirmation.reset();
  pendingNames = false;
  candidateCardSigs = [];
  candidateCardKey = '';
  awaitingNames = false;
  wasShop = false;
  settledSig = pendingSig = null;
  knownHero = null;
  selfHeroConfirmation.reset();
  lastRosterReadFrame = -1;
  nextTeamRetryAt = 0;
  pendingPreparationCorrection = false;
  pendingIdentityMeta = null;
  freshMetaCache = null;
  acceptedRound = acceptedChoice = 0;
  previousBarSig = null;
  previousRound = 0;
};
// Dev builds only (`import.meta.env.DEV` is false in a production build, so this all folds away): milliseconds per
// recogniser stage, sent back on each result for the page's perf summary.
const DEV = import.meta.env.DEV;
let stages: Record<string, number> | undefined;
const stage = <T>(name: string, fn: () => T): T => {
  if (!stages) return fn();
  const t = performance.now();
  try {
    return fn();
  } finally {
    stages[name] = performance.now() - t;
  }
};
const readMetadata = (
  img: ReturnType<typeof pasteRegions>,
  idx: DecodedIndex,
  round: number,
  known?: { bar: DraftMeta['bar']; self: number },
) => {
  const meta =
    !known && freshMetaCache?.frame === captureSequence && freshMetaCache.round === round
      ? { ...freshMetaCache.meta }
      : readDraftMeta(img, idx, known, round !== 1);
  meta.self = selfHeroConfirmation.value?.heroId ?? 0;
  if (!known) freshMetaCache = { frame: captureSequence, round, meta: { ...meta } };
  if (!known && round === 1 && !teamRoster.complete && lastRosterReadFrame !== captureSequence) {
    teamRoster.observe(meta);
    lastRosterReadFrame = captureSequence;
  }
  meta.rerollsRemaining = rerollCounter.value ?? meta.rerollsRemaining;
  return meta;
};
// Pre-bake: the hero bar (eight portraits) is the slowest read, about 0.8 s, and it is the same for the whole match.
// Keep the last read with a fingerprint of the bar's pixels; a later draft screen whose bar still matches reuses it
// instead of searching all eight portraits again. A new match (other portraits) fails the check and is read afresh.
const BAR_SIG_MAX_CHANGED = 12; // of ~200 sampled channel values; a different portrait moves most of them
let matchBar: { bar: DraftMeta['bar']; self: number; sig: Uint8Array } | null = null;
const barSig = (img: { width: number; height: number; data: Uint8ClampedArray }): Uint8Array => {
  const { sx, sy, offsetX } = hudLayout(img.width, img.height);
  const out: number[] = [];
  for (const cx of [...HERO_BAR.left, ...HERO_BAR.right])
    for (let dy = -30; dy <= 30; dy += 15)
      for (let dx = -30; dx <= 30; dx += 15) {
        const i = (Math.round((HERO_BAR.cy + dy) * sy) * img.width + Math.round(offsetX + (cx + dx) * sx)) * 4;
        out.push(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      }
  return Uint8Array.from(out);
};
const sameBar = (a: Uint8Array, b: Uint8Array) => {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 40 && ++changed > BAR_SIG_MAX_CHANGED) return false;
  return true;
};
const post = (m: WorkerOut) => {
  if (m.type === 'result') {
    if (pendingPreparationCorrection && m.meta?.self === selfHeroConfirmation.value?.heroId) {
      m = { ...m, transition: 'hero' };
      // MatchMemory can consume the correction only once all four current opponents are readable.
      if (completeRoster(m.meta)) pendingPreparationCorrection = false;
    }
    const wasPreparation = preparation.visible;
    preparation.observe(
      {
        shop: m.shop,
        round: m.shop ? m.round : preparationRound,
        countdown: frameCountdown,
        confirmedRound: m.shop && m.accepted,
        sample: preparationSample,
      },
      performance.now(),
    );
    if (wasPreparation && !preparation.visible && !m.shop) teamRoster.reset();
    m = { ...m, roundCountdown: frameCountdown, preparationRound, preparationSample, metadataSample: captureSequence };
  }
  (self as unknown as { postMessage(m: unknown): void }).postMessage({ ...m, captureEpoch });
};
let timer: ReturnType<typeof setTimeout> | undefined;
const tick = (after: number, full: boolean) => {
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: 'tick', full: full || preparation.visible }), after);
}; // one chain, even if the page sent two frames

self.addEventListener(
  'message',
  serialFrames(
    async (ev: MessageEvent<WorkerIn>) => {
      const msg = ev.data;
      if (msg.type === 'stop') {
        clearTimeout(timer);
        forgetDraft();
        matchBar = null;
        void terminateOCR();
        void stopItemNameOCR();
        return;
      }
      if (msg.type === 'warm') {
        // Sent when the app opens, long before a draft: decode the icon index now so the first frame does not.
        index ??= decodeIconIndex(msg.index);
        tiers = msg.tiers;
        names = msg.index.names ?? {};
        return;
      }
      if (msg.type === 'init' || msg.type === 'reset') {
        captureEpoch = msg.captureEpoch ?? captureEpoch;
        if (msg.type === 'init') {
          index ??= decodeIconIndex(msg.index);
          tiers = msg.tiers;
          names = msg.index.names ?? {};
          intervalMs = msg.intervalMs;
        }
        forgetDraft();
        warmOCR(); // capture only runs around the draft now: load the OCR engine with it (freed again on 'stop')
        tick(0, true); // F8 may begin after all item picks: read the countdown and ROUND once too.
        return;
      }
      if (msg.type === 'idle') {
        tick(intervalMs, false);
        return;
      }
      if (
        (msg.type === 'frame' || msg.type === 'probe') &&
        msg.captureEpoch !== undefined &&
        msg.captureEpoch !== captureEpoch
      )
        return;
      if (!index) return;
      const idx = index; // narrowed for the stage closures below
      const t0 = performance.now();
      if (msg.type === 'probe') {
        frameCountdown = false;
        preparationRound = 0;
        const crop = {
          width: msg.width,
          height: msg.height,
          data: new Uint8ClampedArray(msg.buffer),
          channels: 4 as const,
          origin: { x: msg.x, y: msg.y, fullWidth: msg.frameW, fullHeight: msg.frameH },
        };
        if (isShopScreen(crop)) {
          tick(0, true); // a draft screen: ask for the whole frame right away
          return;
        }
        if (acceptedKey) {
          tick(0, true);
          return;
        }
        post(nonShopResult(t0));
        // A single non-draft frame between two draft frames is a blink: check again soon before going slow.
        tick(wasShop ? intervalMs : IDLE_INTERVAL_MS, false);
        wasShop = false;
        return;
      }
      stages = DEV ? {} : undefined;
      preparationSample++;
      const img = stage('paste', () => pasteRegions(msg.width, msg.height, msg.regions));
      // Skip card/inventory recognition entirely off the shop screen (menus, gameplay, the round-end transition
      // into the next shop) -- isShopScreen is one small glyph read instead of three full icon searches.
      const labels = readRoundChoice(img);
      frameCountdown = stage('countdown', () => hasRoundCountdown(img));
      preparationRound = labels.round;
      if (labels.choice === 0) {
        const firstPreparation = preparation.observe(
          { shop: false, round: labels.round, countdown: frameCountdown, sample: preparationSample },
          performance.now(),
        );
        if (firstPreparation && labels.round === 1 && frameCountdown) {
          const captured = ++captureSequence;
          if (selfHeroConfirmation.due(performance.now())) {
            const previous = selfHeroConfirmation.value;
            const observation = stage('self', () => readPlayerHero(img, idx));
            if (selfHeroConfirmation.observe(observation, captured, performance.now())) {
              if (previous) {
                teamRoster.reset();
                pendingPreparationCorrection = true;
                settledMeta = null;
                knownHero = matchBar = null;
                settledBarSig = null;
                freshMetaCache = null;
                pendingIdentityMeta = null;
              }
              nextTeamRetryAt = 0;
            }
          }
        }
        if (
          firstPreparation &&
          labels.round === 1 &&
          frameCountdown &&
          selfHeroConfirmation.value &&
          !teamRoster.complete &&
          performance.now() >= nextTeamRetryAt
        ) {
          const teamMeta = stage('team', () => readMetadata(img, idx, 1));
          teamMeta.round = 1;
          teamMeta.choice = 0;
          // A retained card tuple must replay the current interpretation of player and opposing side.
          settledMeta = { ...teamMeta, round: acceptedRound || 1, choice: acceptedChoice };
          settledBarSig = barSig(img);
          knownHero = completeRoster(teamMeta) ? { bar: teamMeta.bar, self: teamMeta.self } : null;
          matchBar = knownHero ? { ...knownHero, sig: settledBarSig } : null;
          nextTeamRetryAt = performance.now() + (teamRoster.value ? 2000 : 500);
          post({
            type: 'result',
            identityOnly: true,
            shop: false,
            round: 1,
            choice: 0,
            accepted: false,
            transition: 'metadata',
            reads: [],
            key: '',
            meta: teamMeta,
            teamRoster: teamRoster.value,
            inventory: null,
            ms: performance.now() - t0,
            stages,
          });
        }
        const cardsRemain =
          acceptedKey &&
          cardSignatures(img).some(
            (sig, slot) =>
              !!committedCardSigs[slot] &&
              hasCardTexture(committedCardSigs[slot]!) &&
              sameSig(committedCardSigs[slot]!, sig),
          );
        if (cardsRemain) {
          closedSince = null;
          pollRerolls(img);
          post({
            type: 'result',
            shop: true,
            round: acceptedRound,
            choice: acceptedChoice,
            pending: awaitingNames || offerLock.awaitingReroll || offerLock.settling || undefined,
            pendingTransition: awaitingNames || offerLock.settling || undefined,
            reads: awaitingNames || offerLock.awaitingReroll || offerLock.settling ? [] : settledReads,
            key: awaitingNames || offerLock.awaitingReroll || offerLock.settling ? '' : acceptedKey,
            accepted: false,
            meta: settledMeta,
            inventory: null,
            ms: performance.now() - t0,
            stages,
          });
          tick(SETTLED_INTERVAL_MS, true);
          return;
        }
        post(nonShopResult(t0));
        tick(acceptedKey ? SETTLED_INTERVAL_MS : wasShop ? intervalMs : IDLE_INTERVAL_MS, !!acceptedKey);
        wasShop = false;
        return;
      }
      closedSince = null;
      wasShop = true;
      const captured = ++captureSequence;
      if (acceptedKey && (labels.choice !== acceptedChoice || (labels.round > 0 && labels.round !== acceptedRound))) {
        const alreadySettling = offerLock.settling;
        offerLock.observe({ ...labels, key: '' }, performance.now(), false, { frame: captured, labelsOnly: true });
        if (!alreadySettling && offerLock.settling) {
          offerEpoch++;
          recovery.reset();
        }
        if (offerLock.settling)
          post({
            type: 'result',
            shop: true,
            pending: true,
            pendingTransition: true,
            round: acceptedRound,
            choice: acceptedChoice,
            reads: [],
            key: '',
            accepted: false,
            meta: null,
            inventory: null,
            ms: performance.now() - t0,
          });
      }
      const inventoryRects = inventoryRegions(img.width, img.height);
      const sig = frameSig(msg.regions, inventoryRects);
      const bsig = barSig(img);
      let heroTransition: 'hero' | 'metadata' | undefined;
      if (selfHeroConfirmation.due(performance.now())) {
        const previous = selfHeroConfirmation.value;
        const observation = stage('self', () => readPlayerHero(img, idx));
        if (selfHeroConfirmation.observe(observation, captured, performance.now())) {
          heroTransition = previous ? 'hero' : 'metadata';
          // The corrected side can have a different opposing team: refresh once without cached identity.
          if (previous) teamRoster.reset();
          const identityRound = labels.round || acceptedRound;
          settledMeta = stage('meta', () => readMetadata(img, idx, identityRound));
          settledMeta.round = identityRound;
          settledMeta.choice = labels.choice || acceptedChoice;
          if (completeRoster(settledMeta)) {
            matchBar = { bar: settledMeta.bar, self: settledMeta.self, sig: bsig };
            knownHero = matchBar;
            if (!previous && acceptedKey) {
              inventoryConfirmation.reset();
              rosterInventoryReplayed = true;
            }
          } else knownHero = null;
          settledBarSig = bsig;
          pendingIdentityMeta = previous
            ? null
            : { frame: captured, readAt: performance.now() + 500, replayInventory: !!acceptedKey };
          // Player identity is independent of the item's icon/name qualification. Publish it before
          // an expensive weak-card name read, without accepting or exposing that pending offer.
          post({
            type: 'result',
            identityOnly: true,
            shop: true,
            round: identityRound,
            choice: settledMeta.choice,
            accepted: false,
            pending: true,
            transition: heroTransition,
            reads: [],
            key: '',
            meta: settledMeta,
            teamRoster: teamRoster.value,
            inventory: null,
            ms: performance.now() - t0,
            stages,
          });
        }
      }
      if (
        pendingIdentityMeta &&
        pendingIdentityMeta.frame !== captured &&
        performance.now() >= pendingIdentityMeta.readAt
      ) {
        const pending = pendingIdentityMeta;
        pendingIdentityMeta = null;
        const identityRound = labels.round || acceptedRound;
        const freshRoster =
          freshMetaCache &&
          freshMetaCache.frame > pending.frame &&
          completeRoster(freshMetaCache.meta) &&
          matchBar &&
          sameBar(matchBar.sig, bsig);
        settledMeta = freshRoster
          ? { ...freshMetaCache!.meta }
          : stage('meta', () => readMetadata(img, idx, identityRound));
        settledMeta.round = identityRound;
        settledMeta.choice = labels.choice || acceptedChoice;
        if (completeRoster(settledMeta)) {
          matchBar = { bar: settledMeta.bar, self: settledMeta.self, sig: bsig };
          knownHero = matchBar;
          if (pending.replayInventory) {
            inventoryConfirmation.reset();
            rosterInventoryReplayed = true;
          }
        }
        post({
          type: 'result',
          identityOnly: true,
          shop: true,
          round: identityRound,
          choice: settledMeta.choice,
          accepted: false,
          pending: true,
          transition: 'metadata',
          reads: [],
          key: '',
          meta: settledMeta,
          teamRoster: teamRoster.value,
          inventory: null,
          ms: performance.now() - t0,
          stages,
        });
      }
      // Full first-round lineup confirmation has its own cadence. A blocked item OCR must not
      // suppress known hero rates or stop retries for one temporarily masked teammate portrait.
      if (
        labels.round === 1 &&
        selfHeroConfirmation.value &&
        !teamRoster.complete &&
        performance.now() >= nextTeamRetryAt &&
        lastRosterReadFrame !== captured
      ) {
        const teamMeta = stage('team', () => readMetadata(img, idx, 1));
        teamMeta.round = 1;
        teamMeta.choice = labels.choice;
        nextTeamRetryAt = performance.now() + (teamRoster.value ? 2000 : 500);
        post({
          type: 'result',
          identityOnly: true,
          shop: true,
          round: 1,
          choice: labels.choice,
          accepted: false,
          pending: true,
          transition: 'metadata',
          reads: [],
          key: '',
          meta: teamMeta,
          teamRoster: teamRoster.value,
          inventory: null,
          ms: performance.now() - t0,
          stages,
        });
      }
      const rosterChanged = !!matchBar && !sameBar(matchBar.sig, bsig);
      if (rosterChanged) knownHero = null;
      const matchBoundary = !!previousBarSig && !sameBar(previousBarSig, bsig);
      if (matchBoundary) {
        inventoryConfirmation.reset();
        teamRoster.reset();
        nextTeamRetryAt = nextMetaRetryAt = 0;
      }
      previousBarSig = bsig;
      const inventorySig = `${inventorySignature(img, inventoryRects)}:${[...new Set(msg.prefer)].sort((a, b) => a - b).join(',')}`;
      // Give the roster read one frame to catch up before publishing inventory from another match.
      let inventory =
        !matchBoundary && inventoryConfirmation.needsRead(inventorySig)
          ? inventoryConfirmation.observe(
              stage('inventory', () => readInventory(img, idx, msg.prefer)).map((r) => r.itemId),
              inventorySig,
            )
          : null;
      if (inventory) {
        inventoryPick ||= inventory.some(
          (id) => !previousInventory.includes(id) && settledReads.some((r) => r.itemId === id),
        );
        previousInventory = inventory;
      }
      const iconSigs = cardSignatures(img);
      const changedSlots = iconSigs.filter((s, i) => !sameSig(committedCardSigs[i] ?? null, s)).length;
      const samePendingIcons =
        pendingCardSigs.length === 3 && iconSigs.every((s, i) => sameSig(pendingCardSigs[i]!, s));
      if (
        acceptedKey &&
        acceptedKey === lastKey &&
        labels.choice === acceptedChoice &&
        (labels.round === 0 || labels.round === acceptedRound) &&
        (!rosterChanged || (!!settledBarSig && sameBar(settledBarSig, bsig))) &&
        sameSig(settledSig, sig) &&
        !offerLock.awaitingReroll &&
        !offerLock.settling &&
        !offerLock.needsRestore &&
        !awaitingNames &&
        changedSlots === 0
      ) {
        offerLock.observe({ key: acceptedKey, round: acceptedRound, choice: acceptedChoice }, performance.now());
        let recoveredMeta = !!heroTransition;
        if (!completeMetadata(settledMeta) && performance.now() >= nextMetaRetryAt) {
          const previouslyKnownSelf = settledMeta?.self ?? 0;
          settledMeta = stage('meta', () => readMetadata(img, idx, acceptedRound));
          settledMeta.round = acceptedRound;
          settledMeta.choice = acceptedChoice;
          nextMetaRetryAt = performance.now() + (acceptedRound === 1 && teamRoster.value ? 2000 : 500);
          if (completeRoster(settledMeta)) {
            matchBar = { bar: settledMeta.bar, self: settledMeta.self, sig: bsig };
            knownHero = matchBar;
            // Earlier inventory may precede a full roster read. Re-publish it after roster confirmation.
            if (!rosterInventoryReplayed && previouslyKnownSelf) {
              inventoryConfirmation.reset();
              inventory = null;
              rosterInventoryReplayed = true;
            }
            recoveredMeta = true;
          }
        }
        pollRerolls(img);
        if (settledMeta) settledMeta.rerollsRemaining = rerollCounter.value ?? -1;
        post({
          type: 'result',
          shop: true,
          round: acceptedRound,
          choice: acceptedChoice,
          pending: offerLock.awaitingReroll || undefined,
          reads: offerLock.awaitingReroll ? [] : settledReads,
          key: offerLock.awaitingReroll ? '' : acceptedKey,
          accepted: recoveredMeta && !offerLock.awaitingReroll,
          transition: recoveredMeta ? (heroTransition ?? 'metadata') : undefined,
          meta: settledMeta,
          teamRoster: teamRoster.value,
          inventory,
          ms: performance.now() - t0,
          stages,
        });
        tick(SETTLED_INTERVAL_MS, true);
        return;
      }
      // A new picture is about to be read: ask for the next frame now, so the page copies it while this one is being read
      // (the two-frame check below then finds it waiting instead of paying copy + hop after the read). One tick per frame:
      // the end of this handler does not tick again.
      clearTimeout(timer);
      post({ type: 'tick', full: true });
      // A frame that looks the same as the one that just produced a full set of cards (and carries the same choice
      // label) confirms that read without repeating the expensive icon search: a new screen is accepted a frame sooner.
      const confirmed =
        lastKey !== '' && pendingChoice === labels.choice && sameSig(pendingSig, sig) && samePendingIcons;
      let reads = confirmed ? pendingReads : stage('cards', () => readDraftScreen(img, idx, (id) => tiers[id] ?? 0));
      const strong = confirmed ? pendingStrong : reads.map(strongDirectCard);
      const direct = confirmed ? pendingDirect : reads.length === 3 && strong.every(Boolean);
      let nameCorroborated = confirmed && pendingNames;
      const readGeneration = recovery.generation;
      const epoch = offerEpoch;
      if (reads.some((r) => !r.present)) reads = await recovery.recover(img, reads, names, tiers);
      if (readGeneration !== recovery.generation || epoch !== offerEpoch) return;
      const seen = reads.filter((r) => r.present).length;
      let key = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}${r.rare ? 'r' : ''}`).join(',') : '';
      let freshNames = false;
      let itemReadStatus: ItemReadStatus | undefined;
      const namesVisible = cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height)).every((r) =>
        hasItemNameInk(img, r),
      );
      const sameCommittedLabels =
        labels.choice === acceptedChoice && (labels.round === 0 || labels.round === acceptedRound);
      if (
        namesVisible &&
        !direct &&
        !nameCorroborated &&
        key &&
        (!acceptedKey ||
          offerLock.settling ||
          offerLock.awaitingReroll ||
          (key !== acceptedKey && changedSlots === 3 && sameCommittedLabels))
      ) {
        awaitingNames = true;
        const nameCandidate = `${labels.round}:${labels.choice}:${visualEpoch}`;
        const resolving = nameConfirmation.resolve(img, reads, names, tiers, nameCandidate, strong);
        const cachedOutcome = nameConfirmation.getOutcome(nameCandidate);
        itemReadStatus = cachedOutcome ? completedItemStatus(cachedOutcome) : readingItemStatus(strong);
        post({
          type: 'result',
          shop: true,
          pending: true,
          pendingTransition: true,
          itemReadStatus,
          round: acceptedRound,
          choice: acceptedChoice,
          reads: [],
          key: '',
          accepted: false,
          meta: null,
          inventory: null,
          ms: performance.now() - t0,
        });
        const resolved = await resolving;
        if (readGeneration !== recovery.generation || epoch !== offerEpoch) return;
        const outcome = nameConfirmation.getOutcome(nameCandidate);
        if (outcome) itemReadStatus = completedItemStatus(outcome);
        nameCorroborated = freshNames = !!resolved;
        if (resolved) {
          reads = resolved;
          key = reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}${r.rare ? 'r' : ''}`).join(',');
        }
      }
      // Anchor the resolved tuple, so a weak raw misidentification cannot reset exact-name stability on rereads.
      if (
        candidateCardKey !== key ||
        candidateCardSigs.length !== 3 ||
        !iconSigs.every((s, i) => sameSig(candidateCardSigs[i]!, s))
      ) {
        visualEpoch++;
        candidateCardKey = key;
        candidateCardSigs = iconSigs;
        nameCorroborated = freshNames;
      }
      let accepted = false,
        meta: DraftMeta | null = null;
      const wasSettling = offerLock.settling;
      const restore = awaitingNames && sameCommittedLabels && changedSlots === 0 && key === acceptedKey;
      if (restore) offerLock.restoreCurrent();
      const commit =
        offerLock.observe(
          { key: namesVisible && (direct || nameCorroborated) ? key : '', round: labels.round, choice: labels.choice },
          performance.now(),
          inventoryPick,
          { visual: visualEpoch, direct, nameCorroborated, changedSlots, frame: captured },
        ) || restore;
      const transition = restore ? 'metadata' : commit ? (offerLock.transition ?? undefined) : undefined;
      if (!wasSettling && offerLock.settling) {
        offerEpoch++;
        recovery.reset();
      }
      if (commit) {
        awaitingNames = false;
        // A new card set, or the ROUND / CHOICE label changed under the same cards (a stale label must not stand):
        // (re)accept, which re-reads the hero bar and labels once the screen has settled.
        acceptedKey = key;
        acceptedRound = offerLock.current!.round;
        acceptedChoice = offerLock.current!.choice;
        if (previousRound > 1 && acceptedRound === 1) {
          preparation.reset(); // a committed first round after a later round is a new match
          selfHeroConfirmation.reset();
          pendingPreparationCorrection = false;
          knownHero = null;
          inventoryConfirmation.reset();
          inventory = null;
        }
        if (acceptedRound > 0) previousRound = acceptedRound;
        inventoryPick = false;
        accepted = true;
        if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
        meta = stage('meta', () =>
          readMetadata(
            img,
            idx,
            acceptedRound,
            !selfHeroConfirmation.value || (acceptedRound === 1 && !teamRoster.complete)
              ? undefined
              : (knownHero ?? undefined),
          ),
        );
        meta.round = acceptedRound;
        meta.choice = acceptedChoice;
        if (completeRoster(meta)) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
        // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
        knownHero = completeRoster(meta) ? { bar: meta.bar, self: meta.self } : null;
        settledMeta = meta;
        settledBarSig = bsig;
        nextMetaRetryAt = 0;
        rosterInventoryReplayed = false;
        committedCardSigs = confirmed ? pendingCardSigs : iconSigs;
        settledSig = confirmed ? pendingSig : sig;
        settledReads = reads;
      }
      lastKey = key;
      if (!confirmed) {
        // The fingerprints belong to this actual recognition. Reused IDs must keep their original pixel anchor.
        pendingSig = key ? sig : null;
        pendingReads = reads;
        pendingCardSigs = iconSigs;
        pendingDirect = direct;
        pendingStrong = strong;
      } else if (freshNames) {
        // A later exact-name correction and its proof belong to the same tuple. Keep the original
        // pixel/strength anchors, but never replay the old weak IDs with the new tuple's proof.
        pendingReads = reads;
      }
      pendingNames = nameCorroborated;
      pendingChoice = labels.choice;
      if (acceptedKey) pollRerolls(img);
      if (meta) meta.rerollsRemaining = rerollCounter.value ?? -1;
      post({
        type: 'result',
        shop: true,
        pending: !acceptedKey || awaitingNames || offerLock.awaitingReroll || offerLock.settling || undefined,
        pendingTransition: awaitingNames || offerLock.settling || undefined,
        itemReadStatus: !acceptedKey || awaitingNames || offerLock.settling ? itemReadStatus : undefined,
        round: acceptedKey ? acceptedRound : labels.round,
        choice: acceptedKey ? acceptedChoice : labels.choice,
        reads: awaitingNames || offerLock.awaitingReroll || offerLock.settling || !acceptedKey ? [] : settledReads,
        key: awaitingNames || offerLock.awaitingReroll || offerLock.settling || !acceptedKey ? '' : acceptedKey,
        accepted: accepted && !awaitingNames && !offerLock.awaitingReroll && !offerLock.settling,
        transition,
        meta: accepted ? meta : settledMeta,
        teamRoster: teamRoster.value,
        inventory,
        ms: performance.now() - t0,
        stages,
      });
    },
    () => tick(intervalMs, true),
  ),
);

const nonShopResult = (t0: number): FrameResult => {
  closedSince ??= t0;
  if (t0 - closedSince >= 250) {
    if (acceptedKey) offerEpoch++;
    lastKey = acceptedKey = '';
    offerLock.reset();
    if (!preparation.visible) teamRoster.reset();
    committedCardSigs = [];
    inventoryConfirmation.reset();
    settledMeta = null;
    settledBarSig = null;
    nextMetaRetryAt = 0;
    settledSig = pendingSig = null;
    knownHero = null;
    acceptedRound = acceptedChoice = 0;
    pendingReads = [];
    pendingCardSigs = [];
    pendingNames = false;
    candidateCardSigs = [];
    candidateCardKey = '';
    awaitingNames = false;
    nameConfirmation.reset();
  }
  return {
    type: 'result',
    shop: false,
    round: 0,
    choice: 0,
    reads: [],
    key: '',
    accepted: false,
    meta: null,
    teamRoster: teamRoster.value,
    inventory: null,
    ms: performance.now() - t0,
  };
};
