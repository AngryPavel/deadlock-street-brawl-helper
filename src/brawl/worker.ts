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
import { TeamRosterConfirmation, type TeamRoster } from '../local/teamWinRate';
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
  | { type: 'init'; index: IconIndex; tiers: Record<number, number>; intervalMs: number }
  // A draft frame is only the rectangles the recogniser reads (draftRegions), each with its own pixels: the worker
  // pastes them into a reused frame-sized buffer, so nothing outside them is ever copied out of the video.
  | { type: 'frame'; width: number; height: number; regions: FrameRegion[]; prefer: number[] }
  // Off the draft screen the page copies just the "CHOICE n OF 3" crop (see shopProbeRect) instead of a whole frame.
  | {
      type: 'probe';
      frameW: number;
      frameH: number;
      x: number;
      y: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | { type: 'idle' } // the page had no frame ready for the last tick
  | { type: 'reset' } // capture (re)started: forget the last draft and start ticking again
  | { type: 'stop' }; // capture stopped: forget the last draft and free the OCR engine; the worker then stays silent

/** The worker paces the capture: it asks the page for a frame, reads it, waits, asks again. Page timers are
 *  throttled to once a second (Chrome: once a minute after five minutes) while the game has the foreground and the
 *  browser tab is hidden; worker timers are not, so the advice keeps updating without alt-tabbing. */
export type WorkerOut =
  | FrameResult
  | { type: 'tick'; full: boolean } // full: send a whole frame; otherwise just the probe crop
  | { type: 'rerolls'; forKey: string; forRound: number; forChoice: number; rerollsRemaining: number; spent: boolean };

export interface FrameResult {
  teamRoster?: TeamRoster | null;
  transition?: 'initial' | 'choice' | 'round' | 'reroll' | 'metadata' | 'reacquire';
  pendingTransition?: boolean;
  pending?: boolean;
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
let offerEpoch = 0;
let closedSince: number | null = null;
let committedCardSigs: Uint8Array[] = [];
let pendingCardSigs: Uint8Array[] = [];
let visualEpoch = 0;
let pendingDirect = false;
let captureSequence = 0;
let previousInventory: number[] = [];
let inventoryPick = false;
let settledMeta: DraftMeta | null = null;
let settledBarSig: Uint8Array | null = null;
let nextMetaRetryAt = 0;
let rosterInventoryReplayed = false;
const completeRoster = (meta: DraftMeta | null) => !!meta?.self && new Set(enemiesFrom(meta.bar, meta.self)).size === 4;
const completeMetadata = (meta: DraftMeta | null) =>
  completeRoster(meta) && (acceptedRound !== 1 || !!teamRoster.value);
const rerollCounter = new RerollCounterReader();
const recovery = new CardNameRecovery();
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
  wasShop = false;
  settledSig = pendingSig = null;
  knownHero = null;
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
const post = (m: WorkerOut) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let timer: ReturnType<typeof setTimeout> | undefined;
const tick = (after: number, full: boolean) => {
  clearTimeout(timer);
  timer = setTimeout(() => post({ type: 'tick', full }), after);
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
        if (msg.type === 'init') {
          index ??= decodeIconIndex(msg.index);
          tiers = msg.tiers;
          names = msg.index.names ?? {};
          intervalMs = msg.intervalMs;
        }
        forgetDraft();
        warmOCR(); // capture only runs around the draft now: load the OCR engine with it (freed again on 'stop')
        tick(0, false);
        return;
      }
      if (msg.type === 'idle') {
        tick(intervalMs, false);
        return;
      }
      if (!index) return;
      const idx = index; // narrowed for the stage closures below
      const t0 = performance.now();
      if (msg.type === 'probe') {
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
      const img = stage('paste', () => pasteRegions(msg.width, msg.height, msg.regions));
      // Skip card/inventory recognition entirely off the shop screen (menus, gameplay, the round-end transition
      // into the next shop) -- isShopScreen is one small glyph read instead of three full icon searches.
      const labels = readRoundChoice(img);
      if (labels.choice === 0) {
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
            pending: offerLock.awaitingReroll || offerLock.settling || undefined,
            pendingTransition: offerLock.settling || undefined,
            reads: offerLock.awaitingReroll || offerLock.settling ? [] : settledReads,
            key: offerLock.awaitingReroll || offerLock.settling ? '' : acceptedKey,
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
      const rosterChanged = !!matchBar && !sameBar(matchBar.sig, bsig);
      if (rosterChanged) knownHero = null;
      const matchBoundary = !!previousBarSig && !sameBar(previousBarSig, bsig);
      if (matchBoundary) {
        inventoryConfirmation.reset();
        teamRoster.reset();
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
      if (!samePendingIcons) visualEpoch++;
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
        changedSlots === 0
      ) {
        offerLock.observe({ key: acceptedKey, round: acceptedRound, choice: acceptedChoice }, performance.now());
        let recoveredMeta = false;
        if (!completeMetadata(settledMeta) && performance.now() >= nextMetaRetryAt) {
          settledMeta = stage('meta', () => readDraftMeta(img, idx, undefined, acceptedRound !== 1));
          if (acceptedRound === 1) teamRoster.observe(settledMeta);
          settledMeta.round = acceptedRound;
          settledMeta.choice = acceptedChoice;
          nextMetaRetryAt = performance.now() + 500;
          if (completeRoster(settledMeta)) {
            matchBar = { bar: settledMeta.bar, self: settledMeta.self, sig: bsig };
            knownHero = matchBar;
            // Earlier inventory may precede a full roster read. Re-publish it after roster confirmation.
            if (!rosterInventoryReplayed) {
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
          transition: recoveredMeta ? 'metadata' : undefined,
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
      const strongIcon = (r: CardRead) => r.present && r.match?.score >= 0.82 && r.match.margin >= 0.08;
      const direct = confirmed ? pendingDirect : reads.length === 3 && reads.every(strongIcon);
      const readGeneration = recovery.generation;
      const epoch = offerEpoch;
      if (reads.some((r) => !r.present)) reads = await recovery.recover(img, reads, names, tiers);
      if (readGeneration !== recovery.generation || epoch !== offerEpoch) return;
      const seen = reads.filter((r) => r.present).length;
      const key =
        seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}${r.rare ? 'r' : ''}`).join(',') : '';
      let accepted = false,
        meta: DraftMeta | null = null;
      const wasSettling = offerLock.settling;
      const commit = offerLock.observe(
        { key, round: labels.round, choice: labels.choice },
        performance.now(),
        inventoryPick,
        { visual: visualEpoch, direct, changedSlots, frame: captured },
      );
      const transition = commit ? (offerLock.transition ?? undefined) : undefined;
      if (!wasSettling && offerLock.settling) {
        offerEpoch++;
        recovery.reset();
      }
      if (commit) {
        // A new card set, or the ROUND / CHOICE label changed under the same cards (a stale label must not stand):
        // (re)accept, which re-reads the hero bar and labels once the screen has settled.
        acceptedKey = key;
        acceptedRound = offerLock.current!.round;
        acceptedChoice = offerLock.current!.choice;
        if (previousRound > 1 && acceptedRound === 1) {
          inventoryConfirmation.reset();
          inventory = null;
        }
        if (acceptedRound > 0) previousRound = acceptedRound;
        inventoryPick = false;
        accepted = true;
        if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
        meta = stage('meta', () =>
          readDraftMeta(
            img,
            idx,
            acceptedRound === 1 && !teamRoster.value ? undefined : (knownHero ?? undefined),
            acceptedRound !== 1,
          ),
        );
        if (acceptedRound === 1 && !teamRoster.value) teamRoster.observe(meta);
        meta.round = acceptedRound;
        meta.choice = acceptedChoice;
        if (completeRoster(meta)) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
        // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
        knownHero = completeRoster(meta) ? { bar: meta.bar, self: meta.self } : null;
        settledMeta = meta;
        settledBarSig = bsig;
        nextMetaRetryAt = 0;
        rosterInventoryReplayed = false;
        committedCardSigs = cardSignatures(img);
        settledSig = sig;
        settledReads = reads;
      }
      lastKey = key;
      pendingSig = key ? sig : null;
      pendingReads = reads;
      pendingCardSigs = iconSigs;
      pendingDirect = direct;
      pendingChoice = labels.choice;
      if (acceptedKey) pollRerolls(img);
      if (meta) meta.rerollsRemaining = rerollCounter.value ?? -1;
      post({
        type: 'result',
        shop: true,
        pending: !acceptedKey || offerLock.awaitingReroll || offerLock.settling || undefined,
        pendingTransition: offerLock.settling || undefined,
        round: acceptedKey ? acceptedRound : labels.round,
        choice: acceptedKey ? acceptedChoice : labels.choice,
        reads: offerLock.awaitingReroll || offerLock.settling || !acceptedKey ? [] : settledReads,
        key: offerLock.awaitingReroll || offerLock.settling || !acceptedKey ? '' : acceptedKey,
        accepted: accepted && !offerLock.awaitingReroll && !offerLock.settling,
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
    teamRoster.reset();
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
    inventory: null,
    ms: performance.now() - t0,
  };
};
