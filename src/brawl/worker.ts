// Web Worker that runs the Street Brawl screen recogniser off the main thread, so the page and the overlay stay
// responsive while frames are read. It keeps the small amount of state needed to decide when a screen is "new":
// cards are accepted once two consecutive frames agree, and the expensive labels / hero bar read runs only then.
import {
  BRAWL_LAYOUT,
  HERO_BAR,
  decodeIconIndex,
  isShopScreen,
  readDraftMeta,
  readRoundChoice,
  readDraftScreen,
  readInventory,
  type CardRead,
  type DecodedIndex,
  type DraftMeta,
  type InventoryRead,
} from './recognise';
import { readRerollsRemaining, terminateOCR, warmOCR } from './ocr';
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
  | { type: 'rerolls'; forKey: string; rerollsRemaining: number };

export interface FrameResult {
  type: 'result';
  shop: boolean; // isShopScreen(img) for this frame -- false means card/inventory recognition was skipped entirely
  round: number; // this frame's ROUND / CHOICE labels (0: unread; always 0 on a non-draft frame)
  choice: number;
  reads: CardRead[];
  key: string; // item ids of the three cards, '' when fewer than three are visible
  accepted: boolean; // true on the frame a new stable set of three cards is first accepted
  meta: DraftMeta | null; // round / choice / hero bar, on the accepted frame only
  inventory: number[] | null; // owned items from the inventory grid, once two consecutive reads agree; null otherwise
  ms: number;
  stages?: Record<string, number>; // dev builds only: milliseconds per recogniser stage
}

let index: DecodedIndex | null = null;
let tiers: Record<number, number> = {};
let lastKey = '',
  acceptedKey = '';
let lastInv = '',
  sentInv = '';
// re-roll caption re-reads on a settled draft screen (see the draft branch of the frame handler)
let rerollBusy = false,
  rerollAt = 0,
  rerollLast = -2,
  rerollKey = '';

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
const frameSig = (regions: FrameRegion[]): Uint8Array => {
  const out: number[] = [];
  for (const r of regions) {
    const d = new Uint8ClampedArray(r.buffer);
    for (let y = 0; y < r.height; y += SIG_STEP)
      for (let x = 0; x < r.width; x += SIG_STEP) {
        const i = (y * r.width + x) * 4;
        out.push(d[i]!, d[i + 1]!, d[i + 2]!);
      }
  }
  return Uint8Array.from(out);
};
// Reused across frames (same regions every time, so nothing stale survives); reallocated when the frame size changes.
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

const forgetDraft = () => {
  lastKey = acceptedKey = lastInv = sentInv = '';
  rerollLast = -2;
  rerollKey = '';
  wasShop = false;
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
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
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height,
    out: number[] = [];
  for (const cx of [...HERO_BAR.left, ...HERO_BAR.right])
    for (let dy = -30; dy <= 30; dy += 15)
      for (let dx = -30; dx <= 30; dx += 15) {
        const i = (Math.round((HERO_BAR.cy + dy) * sy) * img.width + Math.round((cx + dx) * sx)) * 4;
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

self.addEventListener('message', (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'stop') {
    clearTimeout(timer);
    forgetDraft();
    matchBar = null;
    void terminateOCR();
    return;
  }
  if (msg.type === 'warm') {
    // Sent when the app opens, long before a draft: decode the icon index now so the first frame does not.
    index ??= decodeIconIndex(msg.index);
    tiers = msg.tiers;
    return;
  }
  if (msg.type === 'init' || msg.type === 'reset') {
    if (msg.type === 'init') {
      index ??= decodeIconIndex(msg.index);
      tiers = msg.tiers;
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
    post(nonShopResult(t0));
    tick(wasShop ? intervalMs : IDLE_INTERVAL_MS, false);
    wasShop = false;
    return;
  }
  wasShop = true;
  const sig = frameSig(msg.regions);
  if (
    acceptedKey &&
    acceptedKey === lastKey &&
    labels.choice === acceptedChoice &&
    (labels.round === 0 || labels.round === acceptedRound) &&
    sameSig(settledSig, sig)
  ) {
    post({
      type: 'result',
      shop: true,
      round: labels.round,
      choice: labels.choice,
      reads: settledReads,
      key: acceptedKey,
      accepted: false,
      meta: null,
      inventory: null,
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
  const confirmed = lastKey !== '' && pendingChoice === labels.choice && sameSig(pendingSig, sig);
  const reads = confirmed ? pendingReads : stage('cards', () => readDraftScreen(img, idx, (id) => tiers[id] ?? 0));
  const seen = reads.filter((r) => r.present).length;
  const key = seen === 3 ? reads.map((r) => `${r.itemId}${r.enhanced ? '+' : ''}`).join(',') : '';
  let accepted = false,
    meta: DraftMeta | null = null,
    inventory: number[] | null = null;
  if (key && key === lastKey) {
    // A new card set, or the ROUND / CHOICE label changed under the same cards (a stale label must not stand):
    // (re)accept, which re-reads the hero bar and labels once the screen has settled.
    const labelsChanged =
      key === acceptedKey && (labels.choice !== acceptedChoice || (labels.round > 0 && labels.round !== acceptedRound));
    if (key !== acceptedKey || labelsChanged) {
      acceptedKey = key;
      acceptedChoice = labels.choice;
      if (labels.round > 0) acceptedRound = labels.round;
      accepted = true;
      const bsig = barSig(img);
      if (!knownHero && matchBar && sameBar(matchBar.sig, bsig)) knownHero = matchBar;
      meta = stage('meta', () => readDraftMeta(img, idx, knownHero ?? undefined, true));
      if (meta.self) matchBar = { bar: meta.bar, self: meta.self, sig: bsig };
      // the hero bar is constant while the draft screen stays up; keep it until the screen closes (nonShopResult)
      knownHero = meta.self ? { bar: meta.bar, self: meta.self } : null;
      // rerollsRemaining above is only the fast "is there a glyph at all" read (0 or -1 pending); resolve
      // the actual digit via real OCR off the hot path and post it once it's ready, tagged with the key it
      // was read for so a stale, slow OCR result from a since-superseded card set is never applied.
      if (meta.rerollsRemaining < 0) {
        const forKey = key;
        readRerollsRemaining(img)
          .then((rerollsRemaining) => {
            rerollLast = rerollsRemaining;
            rerollKey = forKey;
            post({ type: 'rerolls', forKey, rerollsRemaining });
          })
          .catch(() => {}); // the OCR engine was freed (capture stopped) while this was running
      }
    }
    // The caption can update a beat after the cards do (or the first read can land mid-animation), so keep
    // re-reading it on the settled screen and post whenever the count changes. Throttled, one read at a time.
    if (!accepted && key === acceptedKey) {
      const now = Date.now();
      if (!rerollBusy && now - rerollAt > 600) {
        rerollBusy = true;
        rerollAt = now;
        const forKey = key;
        readRerollsRemaining(img)
          .then((v) => {
            if (v !== rerollLast || forKey !== rerollKey) {
              rerollLast = v;
              rerollKey = forKey;
              post({ type: 'rerolls', forKey, rerollsRemaining: v });
            }
          })
          .catch(() => {})
          .finally(() => {
            rerollBusy = false;
          });
      }
    }
    // the inventory grid is only on the draft screen; accept a read once two frames agree
    const inv: InventoryRead[] = stage('inventory', () => readInventory(img, idx, msg.prefer));
    const ids = inv
      .map((r) => r.itemId)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const ik = ids.join(',');
    if (ik === lastInv && ik !== sentInv) {
      sentInv = ik;
      inventory = ids;
    }
    lastInv = ik;
  } else if (!key) lastInv = '';
  lastKey = key;
  pendingSig = key ? sig : null;
  pendingReads = reads;
  pendingChoice = labels.choice;
  settledSig = key !== '' && key === acceptedKey ? sig : null;
  settledReads = reads;
  post({
    type: 'result',
    shop: true,
    round: labels.round,
    choice: labels.choice,
    reads,
    key,
    accepted,
    meta,
    inventory,
    ms: performance.now() - t0,
    stages,
  });
});

const nonShopResult = (t0: number): FrameResult => {
  lastKey = acceptedKey = lastInv = sentInv = '';
  settledSig = pendingSig = null;
  knownHero = null;
  acceptedRound = acceptedChoice = 0;
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
