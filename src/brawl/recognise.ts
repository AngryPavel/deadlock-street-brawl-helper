// Street Brawl draft-screen recogniser: pure pixel code, no DOM and no Node APIs, so the same function runs
// in the browser (canvas) and in the fixture test (sharp). Layout constants are fractions of a 2560x1440
// screen and were measured from the user's screenshots; a different resolution scales linearly.
import type { IconIndex } from './types';

export interface RGBImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  channels: 3 | 4;
  /** Set when `data` is only a crop of a bigger frame: (x, y) is the crop's top-left in full-frame px and
   *  fullWidth/fullHeight the whole frame's size, so layout anchors still scale from the full frame. */
  origin?: { x: number; y: number; fullWidth: number; fullHeight: number };
}

/** Draft screen at 2560x1440: three cards, icon centres and icon edge length in pixels. */
export const BRAWL_LAYOUT = {
  ref: { width: 2560, height: 1440 },
  cards: [
    { name: 'left', cx: 712, cy: 855 },
    { name: 'top', cx: 1280, cy: 527 },
    { name: 'right', cx: 1848, cy: 855 },
  ],
  icon: 185, // icon edge on screen
  search: 24, // +- pixels of position slack when locating the icon
  scales: [0.92, 0.97, 1.02, 1.07], // icon edge multipliers tried
} as const;

/** Card centres for an arbitrary screen size. */
export const cardAnchors = (width: number, height: number) => {
  const sx = width / BRAWL_LAYOUT.ref.width,
    sy = height / BRAWL_LAYOUT.ref.height;
  return BRAWL_LAYOUT.cards.map((c) => ({ name: c.name, cx: c.cx * sx, cy: c.cy * sy, icon: BRAWL_LAYOUT.icon * sx }));
};

/** The "Use Re-Roll" pill on the draft screen, measured at 2560x1440 from the user's screenshots
 *  (screenshots/brawl/reroll-choice{1,2}.png, gitignored): a light-bordered pill roughly 1140-1420 x 913-996. */
const REROLL_BUTTON = { x0: 1140, y0: 913, x1: 1420, y1: 996 } as const;

/** Re-roll button rect for an arbitrary screen size. */
export const rerollButtonRect = (width: number, height: number) => {
  const sx = width / BRAWL_LAYOUT.ref.width,
    sy = height / BRAWL_LAYOUT.ref.height;
  return {
    x0: REROLL_BUTTON.x0 * sx,
    y0: REROLL_BUTTON.y0 * sy,
    x1: REROLL_BUTTON.x1 * sx,
    y1: REROLL_BUTTON.y1 * sy,
  };
};

export interface DecodedIndex {
  size: number;
  ids: number[];
  pixels: Float32Array[];
  twins: Map<number, number[]>;
  heroIds: number[];
  heroPixels: Float32Array[];
}

const b64 = (s: string): Uint8Array => {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (!B) throw new Error('no base64 decoder');
  return new Uint8Array(B.from(s, 'base64'));
};

/** Mask: 1 for pixels compared, 0 for the top-right corner where the tier numeral sits. */
const iconMask = (size: number): Float32Array => {
  const m = new Float32Array(size * size).fill(1);
  const c = Math.ceil(size * 0.28);
  for (let y = 0; y < c; y++) for (let x = size - c; x < size; x++) m[y * size + x] = 0;
  return m;
};

/** Per-channel mean/std normalised pixels, mask applied, so lighting and background offsets cancel. */
function normalise(px: ArrayLike<number>, size: number, mask: Float32Array): Float32Array {
  const out = new Float32Array(size * size * 3);
  for (let ch = 0; ch < 3; ch++) {
    let s = 0,
      s2 = 0,
      n = 0;
    for (let i = 0; i < size * size; i++)
      if (mask[i]) {
        const v = px[i * 3 + ch];
        s += v;
        s2 += v * v;
        n++;
      }
    const mean = s / n,
      sd = Math.sqrt(Math.max(1e-6, s2 / n - mean * mean));
    for (let i = 0; i < size * size; i++) out[i * 3 + ch] = mask[i] ? (px[i * 3 + ch] - mean) / sd : 0;
  }
  return out;
}

export function decodeIconIndex(idx: IconIndex): DecodedIndex {
  const mask = iconMask(idx.size);
  const ids = Object.keys(idx.icons).map(Number);
  const extras = idx.extras ?? [];
  const twins = new Map<number, number[]>();
  for (const [a, bs] of Object.entries(idx.twins ?? {})) twins.set(Number(a), bs);
  const cmask = circleMask(idx.size);
  const heroIds = Object.keys(idx.heroes ?? {}).map(Number);
  return {
    size: idx.size,
    ids: [...ids, ...extras.map(([id]) => id)],
    pixels: [
      ...ids.map((id) => normalise(b64(idx.icons[id]), idx.size, mask)),
      ...extras.map(([, px]) => normalise(b64(px), idx.size, mask)),
    ],
    twins,
    heroIds,
    heroPixels: heroIds.map((id) => normalise(b64(idx.heroes![id]), idx.size, cmask)),
  };
}

/** Mask: 1 inside the inscribed circle (hero portraits are round). */
const circleMasks = new Map<number, Float32Array>();
const circleMask = (size: number): Float32Array => {
  const cached = circleMasks.get(size);
  if (cached) return cached;
  const m = new Float32Array(size * size);
  circleMasks.set(size, m);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2,
        dy = y + 0.5 - size / 2;
      m[y * size + x] = dx * dx + dy * dy <= (size / 2 - 1) ** 2 ? 1 : 0;
    }
  return m;
};

/** Box-filtered resample of the square (x0, y0, edge) of `img` down to size x size RGB. */
function sampleSquare(img: RGBImage, x0: number, y0: number, edge: number, size: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const step = edge / size,
    ch = img.channels,
    W = img.width,
    H = img.height,
    d = img.data;
  // cell edges, clamped to the image once instead of per pixel
  const xs = new Int32Array(size + 1),
    ys = new Int32Array(size + 1);
  for (let g = 0; g <= size; g++) {
    xs[g] = Math.min(W, Math.max(0, g === size ? Math.ceil(x0 + edge) : Math.floor(x0 + g * step)));
    ys[g] = Math.min(H, Math.max(0, g === size ? Math.ceil(y0 + edge) : Math.floor(y0 + g * step)));
  }
  for (let gy = 0; gy < size; gy++) {
    const ya = ys[gy],
      yb = Math.max(ya, ys[gy + 1] === ya ? ya + 1 : ys[gy + 1]);
    for (let gx = 0; gx < size; gx++) {
      const xa = xs[gx],
        xb = Math.max(xa, xs[gx + 1] === xa ? xa + 1 : xs[gx + 1]);
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let y = ya; y < yb && y < H; y++) {
        let p = (y * W + xa) * ch;
        for (let x = xa; x < xb && x < W; x++, p += ch) {
          r += d[p];
          g += d[p + 1];
          b += d[p + 2];
          n++;
        }
      }
      const o = (gy * size + gx) * 3;
      if (n) {
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
      }
    }
  }
  return out;
}

/** Summed-area table of a rectangle of `img` (per channel), so a box average costs four lookups instead of a walk
 *  over every pixel. Sums are whole numbers well inside a double, so `sampleFast` returns exactly what
 *  `sampleSquare` does. Built once per card / portrait and reused for every position and scale searched there. */
interface Integral {
  x0: number;
  y0: number;
  w: number;
  h: number;
  t: Float64Array;
}
function integralOf(img: RGBImage, bx0: number, by0: number, bx1: number, by1: number): Integral {
  const x0 = Math.max(0, Math.floor(bx0)),
    y0 = Math.max(0, Math.floor(by0)),
    x1 = Math.min(img.width, Math.ceil(bx1)),
    y1 = Math.min(img.height, Math.ceil(by1));
  const w = Math.max(0, x1 - x0),
    h = Math.max(0, y1 - y0),
    ch = img.channels,
    W = img.width,
    d = img.data,
    stride = w + 1,
    t = new Float64Array(stride * (h + 1) * 3);
  for (let y = 0; y < h; y++) {
    let r = 0,
      g = 0,
      b = 0,
      p = ((y0 + y) * W + x0) * ch;
    for (let x = 0; x < w; x++, p += ch) {
      r += d[p];
      g += d[p + 1];
      b += d[p + 2];
      const o = ((y + 1) * stride + x + 1) * 3,
        u = (y * stride + x + 1) * 3;
      t[o] = t[u] + r;
      t[o + 1] = t[u + 1] + g;
      t[o + 2] = t[u + 2] + b;
    }
  }
  return { x0, y0, w, h, t };
}
function sampleFast(img: RGBImage, ig: Integral, x0: number, y0: number, edge: number, size: number): Float32Array {
  const step = edge / size,
    W = img.width,
    H = img.height;
  const xs = new Int32Array(size + 1),
    ys = new Int32Array(size + 1);
  for (let g = 0; g <= size; g++) {
    xs[g] = Math.min(W, Math.max(0, g === size ? Math.ceil(x0 + edge) : Math.floor(x0 + g * step)));
    ys[g] = Math.min(H, Math.max(0, g === size ? Math.ceil(y0 + edge) : Math.floor(y0 + g * step)));
  }
  const ex = ig.x0 + ig.w,
    ey = ig.y0 + ig.h;
  if (
    xs[0] < ig.x0 ||
    ys[0] < ig.y0 ||
    Math.max(xs[size], xs[size - 1] + 1) > ex ||
    Math.max(ys[size], ys[size - 1] + 1) > ey
  )
    return sampleSquare(img, x0, y0, edge, size); // outside the table: the slow path gives the same answer
  const out = new Float32Array(size * size * 3),
    stride = ig.w + 1,
    t = ig.t;
  for (let gy = 0; gy < size; gy++) {
    const ya = ys[gy],
      yb = Math.min(H, Math.max(ya, ys[gy + 1] === ya ? ya + 1 : ys[gy + 1]));
    for (let gx = 0; gx < size; gx++) {
      const xa = xs[gx],
        xb = Math.min(W, Math.max(xa, xs[gx + 1] === xa ? xa + 1 : xs[gx + 1]));
      const n = (xb - xa) * (yb - ya);
      if (n <= 0) continue;
      const a = ((ya - ig.y0) * stride + (xa - ig.x0)) * 3,
        b = ((ya - ig.y0) * stride + (xb - ig.x0)) * 3,
        c = ((yb - ig.y0) * stride + (xa - ig.x0)) * 3,
        e = ((yb - ig.y0) * stride + (xb - ig.x0)) * 3,
        o = (gy * size + gx) * 3;
      out[o] = (t[e] - t[b] - t[c] + t[a]) / n;
      out[o + 1] = (t[e + 1] - t[b + 1] - t[c + 1] + t[a + 1]) / n;
      out[o + 2] = (t[e + 2] - t[b + 2] - t[c + 2] + t[a + 2]) / n;
    }
  }
  return out;
}

const ncc = (a: Float32Array, b: Float32Array, n: number) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / (3 * n);
};

/** `ncc` restricted to the masked-in pixels. The skipped terms are exact zeros (normalise zeroes them), so the sum is
 *  bit-identical to `ncc`, in about the circle's share of the work. */
const maskedOffsets = new Map<Float32Array, Int32Array>();
const offsetsOf = (mask: Float32Array): Int32Array => {
  let o = maskedOffsets.get(mask);
  if (!o) {
    const l: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) l.push(i * 3);
    maskedOffsets.set(mask, (o = Int32Array.from(l)));
  }
  return o;
};
const nccMasked = (a: Float32Array, b: Float32Array, n: number, offs: Int32Array) => {
  let s = 0;
  for (let j = 0; j < offs.length; j++) {
    const i = offs[j];
    s += a[i] * b[i];
    s += a[i + 1] * b[i + 1];
    s += a[i + 2] * b[i + 2];
  }
  return s / (3 * n);
};

export interface IconMatch {
  itemId: number;
  score: number;
  margin: number;
  x: number;
  y: number;
  edge: number;
}

/** Top `k` icon ids for one sampled window (coarse pass). */
const shortlist = (v: Float32Array, pixels: Float32Array[], n: number, k: number): number[] => {
  const scored = pixels.map((p, i) => ({ i, s: ncc(v, p, n) })).sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.i);
};

/**
 * Best item icon for the square roughly centred on (cx, cy) with edge ~ `icon`, searching nearby positions and scales.
 * Coarse-to-fine: the nominal window is scored against every icon, then the position/scale search runs on the top
 * candidates only (about 20x fewer correlations than the exhaustive search, same answers on the fixtures).
 * `candidates` restricts the search to those item ids (used for the inventory grid).
 */
export function matchIcon(
  img: RGBImage,
  index: DecodedIndex,
  cx: number,
  cy: number,
  icon: number,
  candidates?: number[],
  opts?: { search?: number; scales?: readonly number[] },
): IconMatch {
  const mask = iconMask(index.size);
  let n = 0;
  for (const v of mask) n += v;
  const search = opts?.search ?? BRAWL_LAYOUT.search,
    scales = opts?.scales ?? BRAWL_LAYOUT.scales;
  const step = Math.max(2, Math.round(icon / 24));
  let ks: number[]; // positions in the index (an item can have more than one reference icon)
  if (candidates) {
    const want = new Set(candidates);
    ks = [];
    index.ids.forEach((id, k) => want.has(id) && ks.push(k));
  } else {
    const v0 = normalise(sampleSquare(img, cx - icon / 2, cy - icon / 2, icon, index.size), index.size, mask);
    ks = shortlist(v0, index.pixels, n, SHORTLIST);
  }
  let best: IconMatch = { itemId: 0, score: -1, margin: 0, x: 0, y: 0, edge: icon };
  let second = -1;
  const reach = (icon * Math.max(1, ...scales)) / 2 + search + 2;
  const ig = integralOf(img, cx - reach, cy - reach, cx + reach, cy + reach);
  for (const sc of scales) {
    const edge = icon * sc;
    for (let dy = -search; dy <= search; dy += step)
      for (let dx = -search; dx <= search; dx += step) {
        const x = cx - edge / 2 + dx,
          y = cy - edge / 2 + dy;
        const v = normalise(sampleFast(img, ig, x, y, edge, index.size), index.size, mask);
        for (const k of ks) {
          const s = ncc(v, index.pixels[k], n);
          if (s > best.score) {
            if (index.ids[k] !== best.itemId) second = best.score;
            best = { itemId: index.ids[k], score: s, margin: 0, x, y, edge };
          } else if (s > second && index.ids[k] !== best.itemId) second = s;
        }
      }
  }
  best.margin = best.score - second;
  return best;
}
const SHORTLIST = 12;

const MIN_ICON_SCORE = 0.45; // icon similarity floor; between this and SURE_ICON_SCORE a tier numeral must also be read
const SURE_ICON_SCORE = 0.75;

export interface CardRead {
  card: string;
  match: IconMatch;
  present: boolean;
  itemId: number;
  tier: number;
  rare: boolean;
  enhanced: boolean;
}

/** Reads the three draft cards of a full-screen capture. Items that share an icon are told apart by the tier numeral. */
export function readDraftScreen(img: RGBImage, index: DecodedIndex, tierOf: (id: number) => number): CardRead[] {
  return cardAnchors(img.width, img.height).map((a) => {
    const match = matchIcon(img, index, a.cx, a.cy, a.icon);
    const tier = match.score >= MIN_ICON_SCORE ? readTier(img, match) : 0;
    // The numeral only tells twin icons apart: an icon with no twin needs none (a numeral is not always readable, e.g.
    // when the game shows the card without one or the card is hovered).
    const unique = match.score >= MIN_ICON_SCORE && !index.twins?.get(match.itemId)?.length;
    const present = match.score >= SURE_ICON_SCORE || (match.score >= MIN_ICON_SCORE && (tier > 0 || unique));
    const mk = present ? readMarkers(img, match) : { rare: false, enhanced: false, rareFrac: 0, enhancedFrac: 0 };
    return {
      card: a.name,
      match,
      present,
      itemId: present ? resolveTwin(match.itemId, tier, index, tierOf) : 0,
      tier,
      rare: mk.rare,
      enhanced: mk.enhanced,
    };
  });
}

/** When several items share the matched icon (Spirit Armor / Spirit Resilience ...), pick the one whose tier matches the numeral. */
export function resolveTwin(itemId: number, tier: number, index: DecodedIndex, tierOf: (id: number) => number): number {
  if (!tier || tierOf(itemId) === tier) return itemId;
  const twins = index.twins?.get(itemId) ?? [];
  return twins.find((t) => tierOf(t) === tier) ?? itemId;
}

// ---- tier numeral and card markers -----------------------------------------------------------------------
// The tier numeral (I..V) is dark text on the coloured triangle in the icon's top-right corner. Dark pixels in that
// box are projected onto x; each run is a stroke. Narrow runs are "I"s, a wide run is a "V".
const luma = (img: RGBImage, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 255;
  const p = (y * img.width + x) * img.channels;
  return 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
};
const rgb = (img: RGBImage, x: number, y: number): [number, number, number] => {
  if (img.origin) {
    x -= img.origin.x;
    y -= img.origin.y;
  }
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return [0, 0, 0];
  const p = (y * img.width + x) * img.channels;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
};

/** Tier 1..5 read from the numeral, or 0 when no numeral is found. `m` is the icon square from matchIcon. */
export function readTier(img: RGBImage, m: IconMatch): number {
  const u = m.edge / 185,
    right = m.x + m.edge,
    top = m.y;
  const x0 = Math.round(right - 26 * u),
    x1 = Math.round(right - 2 * u);
  const y0 = Math.round(top - 4 * u),
    y1 = Math.round(top + 22 * u);
  // the icon's own dark pixels enter the box from the left edge along the corner diagonal: per row, ignore the
  // dark run that touches x0
  const rowStart: number[] = [];
  for (let y = y0; y < y1; y++) {
    let x = x0;
    while (x < x1 && luma(img, x, y) < 120) x++;
    rowStart.push(x);
  }
  const dark = (x: number, y: number) => x >= rowStart[y - y0] && luma(img, x, y) < 70;
  // 1. the numeral's row band: consecutive rows with some, but not wall-to-wall, dark pixels (borders are wall-to-wall)
  const rowN: number[] = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (dark(x, y)) n++;
    rowN.push(n);
  }
  const okRow = rowN.map((n) => n >= 2 && n <= 16 * u);
  let bestS = 0,
    bestL = 0,
    s0 = 0;
  for (let i = 0; i <= okRow.length; i++) {
    if (i < okRow.length && okRow[i]) {
      if (i === 0 || !okRow[i - 1]) s0 = i;
      if (i - s0 + 1 > bestL) {
        bestL = i - s0 + 1;
        bestS = s0;
      }
    }
  }
  if (bestL < 6 * u) return 0;
  const ya = y0 + bestS,
    yb = ya + bestL;
  // 2. column projection over that band; each run of dark columns is a stroke
  const cols: number[] = [];
  for (let x = x0; x < x1; x++) {
    let n = 0;
    for (let y = ya; y < yb; y++) if (dark(x, y)) n++;
    cols.push(n);
  }
  const minRows = Math.max(2, Math.round(bestL * 0.3));
  const runs: number[] = [];
  let run = 0;
  for (const c of cols) {
    if (c >= minRows) run++;
    else {
      if (run) runs.push(run);
      run = 0;
    }
  }
  if (run) runs.push(run);
  const narrow = runs.filter((w) => w <= 6 * u).length,
    wide = runs.filter((w) => w > 6 * u).length;
  if (wide === 1) return narrow >= 1 ? 4 : 5;
  if (wide === 0 && narrow >= 1 && narrow <= 3) return narrow;
  return 0;
}

const countWhere = (
  img: RGBImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  f: (c: [number, number, number]) => boolean,
) => {
  let n = 0,
    t = 0;
  for (let y = Math.round(y0); y < y1; y += 2)
    for (let x = Math.round(x0); x < x1; x += 2) {
      t++;
      if (f(rgb(img, x, y))) n++;
    }
  return t ? n / t : 0;
};

export interface CardMarkers {
  rare: boolean;
  enhanced: boolean;
  rareFrac: number;
  enhancedFrac: number;
}

/** "RARE!" is teal text above the icon; "ENHANCED" is a blue box under the item name. */
export function readMarkers(img: RGBImage, m: IconMatch): CardMarkers {
  const u = m.edge / 185,
    cx = m.x + m.edge / 2;
  const rareFrac = countWhere(
    img,
    m.x - 10 * u,
    m.y - 48 * u,
    cx + 30 * u,
    m.y - 4 * u,
    ([r, g, b]) => g > 150 && g > r + 50 && b > r + 30 && g > b - 20,
  );
  const enhancedFrac = countWhere(
    img,
    cx - 100 * u,
    m.y + m.edge + 85 * u,
    cx + 100 * u,
    m.y + m.edge + 122 * u,
    ([r, g, b]) => b > 150 && b > r + 60 && b > g + 20,
  );
  return { rare: rareFrac > 0.08, enhanced: enhancedFrac > 0.06, rareFrac, enhancedFrac };
}

// ---- hero bar -------------------------------------------------------------------------------------------
// Eight round portraits along the top: the two teams, four each side of the round timer. Which side is the enemy
// depends on the team the player was put on, so the caller passes its own hero and takes the other side.
export const HERO_BAR = {
  left: [725, 840, 957, 1075],
  right: [1480, 1595, 1710, 1825],
  cy: 72,
  diameter: 100,
  search: 16,
  step: 4,
  scales: [0.92, 1, 1.08],
} as const;
const MIN_HERO_SCORE = 0.6;
const HERO_SHORTLIST = 8;
const MIN_HERO_MARGIN = 0.08;

interface HeroMatch {
  heroId: number;
  score: number;
  margin: number;
}
export interface HeroBar {
  left: HeroMatch[];
  right: HeroMatch[];
}

function matchHero(img: RGBImage, index: DecodedIndex, cx: number, cy: number, diameter: number): HeroMatch {
  const mask = circleMask(index.size),
    offs = offsetsOf(mask);
  let n = 0;
  for (const v of mask) n += v;
  let best: HeroMatch = { heroId: 0, score: -1, margin: 0 },
    second = -1;
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    step = Math.max(2, Math.round(HERO_BAR.step * sx)),
    search = HERO_BAR.search * sx;
  // coarse pass from five windows (centre and the four corners of the search range): portraits shift a little between screens
  const pool = new Set<number>();
  for (const [ox, oy] of [
    [0, 0],
    [-search, -search],
    [search, -search],
    [-search, search],
    [search, search],
  ]) {
    const v0 = normalise(
      sampleSquare(img, cx - diameter / 2 + ox, cy - diameter / 2 + oy, diameter, index.size),
      index.size,
      mask,
    );
    for (const k of shortlist(v0, index.heroPixels, n, HERO_SHORTLIST)) pool.add(index.heroIds[k]);
  }
  const ks = [...pool].map((id) => index.heroIds.indexOf(id));
  const reach = (diameter * Math.max(...HERO_BAR.scales)) / 2 + search + 2;
  const ig = integralOf(img, cx - reach, cy - reach, cx + reach, cy + reach);
  for (const sc of HERO_BAR.scales) {
    const e = diameter * sc;
    for (let dy = -search; dy <= search; dy += step)
      for (let dx = -search; dx <= search; dx += step) {
        const v = normalise(sampleFast(img, ig, cx - e / 2 + dx, cy - e / 2 + dy, e, index.size), index.size, mask);
        for (const k of ks) {
          const s = nccMasked(v, index.heroPixels[k], n, offs);
          if (s > best.score) {
            if (index.heroIds[k] !== best.heroId) second = best.score;
            best = { heroId: index.heroIds[k], score: s, margin: 0 };
          } else if (s > second && index.heroIds[k] !== best.heroId) second = s;
        }
      }
  }
  best.margin = best.score - second;
  if (best.score < MIN_HERO_SCORE || best.margin < MIN_HERO_MARGIN) best.heroId = 0;
  return best;
}

/** Reads the eight portraits; heroId is 0 for a slot that could not be read. */
function readHeroBar(img: RGBImage, index: DecodedIndex): HeroBar {
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const read = (xs: readonly number[]) =>
    xs.map((x) => matchHero(img, index, x * sx, HERO_BAR.cy * sy, HERO_BAR.diameter * sx));
  return { left: read(HERO_BAR.left), right: read(HERO_BAR.right) };
}

/** `readHeroBar` minus the player's three teammates (left as unread slots): `enemiesFrom` and `selfHero` never look at them. */
function readLeanBar(img: RGBImage, index: DecodedIndex, slot: { left: number; right: number }): HeroBar {
  const ownSide = slot.left >= 0 ? 'left' : slot.right >= 0 ? 'right' : null;
  if (!ownSide) return readHeroBar(img, index);
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const read = (side: 'left' | 'right') =>
    HERO_BAR[side].map((x, i): HeroMatch =>
      side === ownSide && i !== slot[side]
        ? { heroId: 0, score: 0, margin: 0 }
        : matchHero(img, index, x * sx, HERO_BAR.cy * sy, HERO_BAR.diameter * sx),
    );
  return { left: read('left'), right: read('right') };
}

// The player's own portrait is the one slot drawn as a square-topped tile (the others are circles): its two vertical
// edges run the full height of the upper half, and the tile fill in the top corners differs from the bar background
// beside it. While the "round starting" banner is up every slot sits in a tile, so a frame where several slots show
// tiles is rejected and the next frame is used.
const SELF_TILE = { edgeRun: 0.9, minScore: 40, maxTiles: 2 } as const;

function pxAt(img: RGBImage, x: number, y: number): [number, number, number] {
  x = Math.min(img.width - 1, Math.max(0, x));
  y = Math.min(img.height - 1, Math.max(0, y));
  const i = (y * img.width + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
const colourDiff = (a: number[], b: number[]) =>
  (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
function meanRect(img: RGBImage, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = pxAt(img, x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n++;
    }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** Index (0..3) of the player's slot on each side, or -1. */
function readSelfSlot(img: RGBImage): { left: number; right: number } {
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const cy = HERO_BAR.cy * sy,
    R = (HERO_BAR.diameter * sx) / 2;
  const y0 = Math.round(cy - 0.9 * R),
    y1 = Math.round(cy - 0.3 * R),
    rows = y1 - y0;
  const cb = Math.round(cy - 0.9 * R),
    ce = Math.round(cy - 0.7 * R);
  const runs = new Map<number, number>();
  const run = (x: number) => {
    let n = runs.get(x);
    if (n === undefined) {
      n = 0;
      for (let y = y0; y < y1; y++) if (colourDiff(pxAt(img, x - 2, y), pxAt(img, x + 2, y)) > 20) n++;
      runs.set(x, n);
    }
    return n;
  };
  const tile = (cx: number) => {
    let best = 0;
    for (let xl = Math.round(cx - 1.3 * R); xl <= cx - 0.7 * R; xl++) {
      if (run(xl) < rows * SELF_TILE.edgeRun) continue;
      for (let xr = Math.round(xl + 1.9 * R); xr <= xl + 2.3 * R; xr++) {
        if (run(xr) < rows * SELF_TILE.edgeRun) continue;
        const inL = meanRect(img, xl + 4, cb, xl + 12, ce),
          inR = meanRect(img, xr - 12, cb, xr - 4, ce);
        const outL = meanRect(img, xl - 10, cb, xl - 4, ce),
          outR = meanRect(img, xr + 4, cb, xr + 10, ce);
        best = Math.max(best, Math.min(colourDiff(inL, outL), colourDiff(inR, outR)) - colourDiff(inL, inR) / 2);
      }
    }
    return best;
  };
  const scores = [...HERO_BAR.left, ...HERO_BAR.right].map((x) => tile(x * sx));
  const tiles = scores.filter((v) => v > 0).length;
  const order = scores.map((_, i) => i).sort((p, q) => scores[q] - scores[p]);
  const ok =
    tiles <= SELF_TILE.maxTiles && scores[order[0]] >= SELF_TILE.minScore && scores[order[0]] >= 2 * scores[order[1]];
  if (!ok) return { left: -1, right: -1 };
  const k = order[0];
  return k < HERO_BAR.left.length ? { left: k, right: -1 } : { left: -1, right: k - HERO_BAR.left.length };
}

/** The player's hero id from the bar, or 0 when the square-topped slot is missing or unreadable. */
function selfHero(bar: HeroBar, self: { left: number; right: number }): number {
  if (self.left >= 0) return bar.left[self.left]?.heroId ?? 0;
  if (self.right >= 0) return bar.right[self.right]?.heroId ?? 0;
  return 0;
}

/** The opposing team's hero ids, given the player's hero; empty when the player's hero is on neither side. */
export function enemiesFrom(bar: HeroBar, myHero: number): number[] {
  const ids = (side: HeroMatch[]) => side.map((m) => m.heroId).filter(Boolean);
  if (ids(bar.left).includes(myHero)) return ids(bar.right);
  if (ids(bar.right).includes(myHero)) return ids(bar.left);
  return [];
}

// ---- round and choice labels --------------------------------------------------------------------------
// "ROUND n" sits above the timer, "CHOICE n OF 3" under the SELECT ITEMS title. The digit is the first glyph in a
// fixed window; it is thresholded on its text colour, cropped to its bounding box and resampled onto an 8x12 grid
// of fill fractions, then compared with templates taken from the same screens (mean squared difference).
const GW = 8,
  GH = 12;
const LABELS = {
  round: { x0: 1318, y0: 50, x1: 1352, y1: 82 },
  choice: { x0: 238, y0: 380, x1: 268, y1: 428 },
  // "N Re-Roll Remaining", muted grey-brown caption under the "Use Re-Roll" button. Measured from
  // screenshots/brawl/reroll-choice{1,2}.png (2000x1125, both showing "1"): the digit's own bbox there is
  // x 918-921, y 804-815, scaled to the 2560x1440 ref by 2560/2000 with margin.
  rerolls: { x0: 1150, y0: 1030, x1: 1215, y1: 1090 },
} as const;
const lightText = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b > 165;
const magentaText = (r: number, g: number, b: number) => r > 140 && b > 140 && g < 130;
// The re-roll caption is dimmer than the round/choice labels (muted grey-brown, not bold white/magenta).
const mutedText = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b > 90;
const tpl = (rows: string[]): Float32Array => Float32Array.from(rows.join(''), (c) => Number(c) / 9);
/** Round digits: bold face with a footed "1" (rows are 8 cells of fill 0-9). The "5" is drawn by hand: no screenshot of round 5 yet. */
const ROUND_DIGITS: Record<number, Float32Array> = {
  1: tpl([
    '00799500',
    '25999500',
    '89999500',
    '99799500',
    '53599500',
    '00599500',
    '00599500',
    '00599500',
    '00599500',
    '66899866',
    '99999999',
    '99999999',
  ]),
  2: tpl([
    '02899982',
    '05999997',
    '38634899',
    '58200699',
    '22001798',
    '00005995',
    '00038962',
    '01488510',
    '26995000',
    '89997666',
    '99999999',
    '99999999',
  ]),
  3: tpl([
    '02799950',
    '07999992',
    '09533995',
    '05000995',
    '00035982',
    '00099920',
    '00099950',
    '00033895',
    '55000599',
    '69533896',
    '29999992',
    '05999950',
  ]),
  4: tpl([
    '00059960',
    '00289960',
    '00599960',
    '02888960',
    '16836960',
    '59506960',
    '69306960',
    '89768986',
    '99999999',
    '33337973',
    '00006960',
    '00006960',
  ]),
  5: tpl([
    '99999999',
    '99999999',
    '99500000',
    '99500000',
    '99999500',
    '99999995',
    '00000999',
    '00000999',
    '00000999',
    '99000999',
    '89999995',
    '19999820',
  ]),
};
/** Choice digits: display face, "1" without a foot. */
const CHOICE_DIGITS: Record<number, Float32Array> = {
  1: tpl([
    '00024679',
    '55789999',
    '99978999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
    '00006999',
  ]),
  2: tpl([
    '59764200',
    '58999874',
    '02346896',
    '00000796',
    '00000796',
    '00001895',
    '00038950',
    '00289610',
    '01796100',
    '38830000',
    '89877777',
    '99999999',
  ]),
  3: tpl([
    '05764200',
    '07999874',
    '02224696',
    '00000396',
    '00014784',
    '00069961',
    '00025898',
    '00000399',
    '32000399',
    '88520498',
    '47987872',
    '01488510',
  ]),
};
const MAX_DIGIT_DISTANCE = 0.06;
const LOOSE_DIGIT_DISTANCE = 0.13;
/** The round digit is only read on the draft screen (the choice label already vouches for that), so it can afford
 *  to accept the softer glyph a scaled-up window gives: a live capture of the 2 sat at 0.14-0.20, runner-up 0.27-0.33. */
const ROUND_LOOSE = { maxDistance: 0.25, ratio: 1.5 };

/** Bounding box (window-relative px) of the first glyph in the window, or null when the window holds no text. */
function readGlyphBBox(
  img: RGBImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  test: (r: number, g: number, b: number) => boolean,
  minWidth = 4,
  /** A column counts as glyph only with this many lit pixels; 2 drops a lone stray pixel from a neighbour. */
  minColPixels = 1,
): { gx0: number; gx1: number; gy0: number; gy1: number } | null {
  const on = (x: number, y: number) => {
    const [r, g, b] = rgb(img, x, y);
    return test(r, g, b);
  };
  const W = x1 - x0,
    H = y1 - y0;
  const colHas: boolean[] = [];
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < H && n < minColPixels; y++) if (on(x0 + x, y0 + y)) n++;
    colHas.push(n >= minColPixels);
  }
  const gx0 = colHas.indexOf(true);
  if (gx0 < 0) return null;
  let gx1 = gx0;
  while (gx1 + 1 < W && (colHas[gx1 + 1] || colHas[gx1 + 2])) gx1++;
  let gy0 = H,
    gy1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = gx0; x <= gx1; x++)
      if (on(x0 + x, y0 + y)) {
        gy0 = Math.min(gy0, y);
        gy1 = Math.max(gy1, y);
      }
  const bw = gx1 - gx0 + 1,
    bh = gy1 - gy0 + 1;
  if (bw < minWidth || bh < 6) return null;
  return { gx0, gx1, gy0, gy1 };
}

/** Fill grid of the first glyph in the window, or null when the window holds no text. */
function readGlyph(
  img: RGBImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  test: (r: number, g: number, b: number) => boolean,
  minColPixels = 1,
): Float32Array | null {
  const on = (x: number, y: number) => {
    const [r, g, b] = rgb(img, x, y);
    return test(r, g, b);
  };
  const box = readGlyphBBox(img, x0, y0, x1, y1, test, 4, minColPixels);
  if (!box) return null;
  const { gx0, gx1, gy0, gy1 } = box;
  const bw = gx1 - gx0 + 1,
    bh = gy1 - gy0 + 1;
  const g = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      let n = 0,
        k = 0;
      for (let y = gy0 + Math.floor((gy * bh) / GH); y < gy0 + Math.ceil(((gy + 1) * bh) / GH); y++)
        for (let x = gx0 + Math.floor((gx * bw) / GW); x < gx0 + Math.ceil(((gx + 1) * bw) / GW); x++) {
          k++;
          if (on(x0 + x, y0 + y)) n++;
        }
      g[gy * GW + gx] = k ? n / k : 0;
    }
  return g;
}

const readDigit = (
  img: RGBImage,
  box: { x0: number; y0: number; x1: number; y1: number },
  test: (r: number, g: number, b: number) => boolean,
  digits: Record<number, Float32Array>,
  /** Accept a blurrier glyph (max distance, and how many times closer than the runner-up it must be). */
  loose: { maxDistance: number; ratio: number } = { maxDistance: LOOSE_DIGIT_DISTANCE, ratio: 2 },
): number => {
  const sx = (img.origin?.fullWidth ?? img.width) / BRAWL_LAYOUT.ref.width,
    sy = (img.origin?.fullHeight ?? img.height) / BRAWL_LAYOUT.ref.height;
  const at = (minCol: number) =>
    readGlyph(
      img,
      Math.round(box.x0 * sx),
      Math.round(box.y0 * sy),
      Math.round(box.x1 * sx),
      Math.round(box.y1 * sy),
      test,
      minCol,
    );
  // Some window sizes (e.g. 1500-1600 px wide) leave a lone stray lit pixel from the neighbouring UI at the edge of
  // the box, which stretches the glyph's bounding box and misses the template: retry ignoring one-pixel columns.
  return matchDigit(at(1), digits, loose) || matchDigit(at(2), digits, loose);
};

const matchDigit = (
  g: Float32Array | null,
  digits: Record<number, Float32Array>,
  loose: { maxDistance: number; ratio: number },
): number => {
  if (!g) return 0;
  let best = 0,
    bestD = Infinity,
    second = Infinity;
  for (const [d, t] of Object.entries(digits)) {
    let s = 0;
    for (let i = 0; i < g.length; i++) s += (g[i]! - t[i]!) ** 2;
    s /= g.length;
    if (s < bestD) {
      second = bestD;
      bestD = s;
      best = Number(d);
    } else if (s < second) second = s;
  }
  // A blurred or vertically stretched screenshot (Test mode's dummy) drifts from the templates; still accept a
  // clearly-best match when it is far closer than the runner-up.
  return bestD <= MAX_DIGIT_DISTANCE || (bestD <= loose.maxDistance && second >= bestD * loose.ratio) ? best : 0;
};

/** RGBA crop of the "N Re-Roll Remaining" caption's own label box (the whole "N Re-Roll..." run, not just
 *  the digit -- real OCR (see ocr.ts) reads the digit out of it fine on its own via the whitelist, and a
 *  plain crop reads far more reliably than a hand-isolated, binarized single-glyph crop did), or null when
 *  the caption isn't showing any text at all (read as 0 re-rolls without needing OCR: no glyph to misread).
 *  Pure pixel work, kept here rather than in ocr.ts so it stays covered by the same no-DOM/no-Node purity as
 *  the rest of this file. */
export function extractRerollLabelCrop(img: RGBImage): { data: Uint8Array; width: number; height: number } | null {
  const box = LABELS.rerolls;
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const x1 = Math.round(box.x1 * sx),
    y1 = Math.round(box.y1 * sy);
  let x0 = Math.round(box.x0 * sx),
    y0 = Math.round(box.y0 * sy);
  // minWidth 2: a soft, dim "1" is only ~3 px wide once the window has been scaled up.
  const bb = readGlyphBBox(img, x0, y0, x1, y1, mutedText, 2);
  if (!bb) return null;
  // only the rows of the digit itself (plus a little air): the empty rest of the box, and the button's edge
  // that a scaled window smears into its top, pull the contrast stretch and the OCR line finder off the text
  const pad = 4;
  const ty0 = Math.max(y0, y0 + bb.gy0 - pad);
  const tx0 = x0;
  const w = x1 - tx0,
    h = Math.min(y1, y0 + bb.gy1 + pad + 1) - ty0;
  y0 = ty0;
  x0 = tx0;
  // Dark text on white, contrast-stretched: the dim caption of a scaled-up window (Test mode, or a real game
  // window that is not 2560x1440) reads as nothing to the OCR engine otherwise.
  const lum = new Float32Array(w * h);
  let lo = 255,
    hi = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(img, x0 + x, y0 + y);
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      lum[y * w + x] = l;
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  const span = Math.max(1, hi - lo);
  // white margin: the OCR engine reads text hard against the crop edge as nothing
  const m = 6,
    ow = w + 2 * m,
    oh = h + 2 * m;
  const data = new Uint8Array(ow * oh * 4).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = 255 - Math.round(((lum[y * w + x]! - lo) / span) * 255);
      const i = ((y + m) * ow + x + m) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  return { data, width: ow, height: oh };
}

/** True when the caption's first glyph is a thin upright bar (a "1", about a third as wide as tall): the fallback
 *  for when OCR cannot read that dim, soft digit. The OCR result wins whenever it produces a digit. */
export function rerollGlyphIsOne(img: RGBImage): boolean {
  const box = LABELS.rerolls;
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const bb = readGlyphBBox(
    img,
    Math.round(box.x0 * sx),
    Math.round(box.y0 * sy),
    Math.round(box.x1 * sx),
    Math.round(box.y1 * sy),
    mutedText,
    2,
  );
  if (!bb) return false;
  const bw = bb.gx1 - bb.gx0 + 1,
    bh = bb.gy1 - bb.gy0 + 1;
  return bh >= 8 && bw / bh <= 0.45;
}

export interface DraftMeta {
  round: number;
  choice: number;
  bar: HeroBar;
  self: number; /* the player's hero id, 0 if unread */
  // read off the "N Re-Roll Remaining" caption: 0 (confident -- no glyph at all) or -1 (a glyph is there,
  // pending the real OCR read in ocr.ts -- see readRerollsRemaining there for the resolved value).
  rerollsRemaining: number;
}
/** Round (1-5), choice (1-3) and the hero bar of a draft screen; 0 for a label that could not be read. */
export function readDraftMeta(
  img: RGBImage,
  index: DecodedIndex,
  /** The hero bar and own hero from an earlier read of the same draft visit: they do not change between choices
   *  and are the slowest part of this read, so a caller may pass them back instead of re-reading. */
  known?: { bar: HeroBar; self: number },
  /** Read only what the advice uses: the player's own portrait and the other team's four. The player's three
   *  teammates come back unread (heroId 0). Falls back to the full bar when the own slot is not found. */
  lean = false,
): DraftMeta {
  const slot = known ? { left: -1, right: -1 } : readSelfSlot(img);
  const bar = known?.bar ?? (lean ? readLeanBar(img, index, slot) : readHeroBar(img, index));
  return {
    round: readDigit(img, LABELS.round, lightText, ROUND_DIGITS, ROUND_LOOSE),
    choice: readDigit(img, LABELS.choice, magentaText, CHOICE_DIGITS),
    bar,
    self: known?.self ?? selfHero(bar, slot),
    rerollsRemaining: extractRerollLabelCrop(img) ? -1 : 0,
  };
}

/** Cheap "are we on the item-draft (shop) screen" check: the "CHOICE n OF 3" line (directly under the
 *  "SELECT ITEMS" title) only renders there, so a successful read of its digit is a reliable, already-calibrated
 *  stand-in for the title text itself -- one small glyph read instead of the three full card icon searches, so
 *  callers can skip card/inventory recognition entirely on every other screen (menus, the round-end/going-shopping
 *  transition, gameplay). */
export function isShopScreen(img: RGBImage): boolean {
  return readDigit(img, LABELS.choice, magentaText, CHOICE_DIGITS) > 0;
}

/** The part of a `width`x`height` frame `isShopScreen` reads (the "CHOICE n OF 3" digit plus slack), in frame
 *  px. Idle polling copies only this crop out of the video instead of the whole frame. */
export function shopProbeRect(width: number, height: number) {
  const sx = width / BRAWL_LAYOUT.ref.width,
    sy = height / BRAWL_LAYOUT.ref.height;
  const b = LABELS.choice;
  const x = Math.max(0, Math.floor(b.x0 * sx) - 4),
    y = Math.max(0, Math.floor(b.y0 * sy) - 4);
  return {
    x,
    y,
    width: Math.min(width, Math.ceil(b.x1 * sx) + 4) - x,
    height: Math.min(height, Math.ceil(b.y1 * sy) + 4) - y,
  };
}

/** Every part of a `width`x`height` draft frame the recogniser ever reads, in frame px: the three card icons (with
 *  the position/scale search slack and the tier numeral), the hero bar with the ROUND label, the CHOICE label, the
 *  re-roll caption and the inventory grid. Everything else on screen is never looked at, so the page copies only
 *  these rectangles out of the video instead of the whole frame (~11 % of its pixels). Padded past what the reads
 *  touch; `regions.test.ts` checks that masking a real frame to these changes no read. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function draftRegions(width: number, height: number): Region[] {
  const sx = width / BRAWL_LAYOUT.ref.width,
    sy = height / BRAWL_LAYOUT.ref.height;
  const boxes: [number, number, number, number][] = [];
  const cardHalf = (BRAWL_LAYOUT.icon * 1.1) / 2 + BRAWL_LAYOUT.search + 20;
  // Extra room below the icon: the ENHANCED box (readMarkers) sits ~85-122 icon-units under it, past a square crop.
  const below = (BRAWL_LAYOUT.icon / 2 + 122 * (BRAWL_LAYOUT.icon / 185) + BRAWL_LAYOUT.search) * 1.1;
  for (const c of BRAWL_LAYOUT.cards)
    boxes.push([c.cx - cardHalf, c.cy - cardHalf, c.cx + cardHalf, c.cy + Math.max(cardHalf, below)]);
  const pad = 12;
  const hb = HERO_BAR;
  boxes.push([hb.left[0] - hb.diameter, 0, hb.right[3] + hb.diameter, hb.cy + hb.diameter + hb.search + pad]);
  const box = (b: { x0: number; y0: number; x1: number; y1: number }) =>
    boxes.push([b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad]);
  box(LABELS.choice);
  box(LABELS.rerolls);
  for (const inv of INVENTORY_LAYOUTS)
    boxes.push([
      inv.x0 - inv.search - pad,
      inv.y0 - inv.search - pad,
      inv.x0 + (inv.cols - 1) * inv.pitch + inv.icon + inv.search + pad,
      inv.y0 + (inv.rows - 1) * inv.pitch + inv.icon + inv.search + pad,
    ]);
  return boxes.map(([x0, y0, x1, y1]) => {
    const x = Math.max(0, Math.floor(x0 * sx)),
      y = Math.max(0, Math.floor(y0 * sy));
    return {
      x,
      y,
      width: Math.min(width, Math.ceil(x1 * sx)) - x,
      height: Math.min(height, Math.ceil(y1 * sy)) - y,
    };
  });
}

/** Round (0 when unread) and choice (0 when unread) labels of the draft screen: two glyph reads, cheap enough
 *  to run on every draft frame so a stale label is noticed as soon as it changes. */
export function readRoundChoice(img: RGBImage): { round: number; choice: number } {
  return {
    round: readDigit(img, LABELS.round, lightText, ROUND_DIGITS, ROUND_LOOSE),
    choice: readDigit(img, LABELS.choice, magentaText, CHOICE_DIGITS),
  };
}

// ---- inventory grid ------------------------------------------------------------------------------------
// The player's items sit bottom-left of the draft screen: two rows of five 66 px icons (2560x1440), 75 px pitch.
// Reading it gives the owned list without any clicking, and a new icon that was on offer is the card the player took.
const INVENTORY = {
  x0: 147,
  y0: 1272,
  pitch: 75,
  icon: 66,
  cols: 5,
  rows: 2,
  search: 6,
  scales: [0.94, 1, 1.06],
} as const;
/** The grid as a newer game build draws it: the stat bars become a row of icons above, the grid moves to the screen
 *  edge and the tiles grow (72 px, 82 px pitch). `readInventory` reads both layouts and keeps the one that matches more. */
const INVENTORY_WIDE = { ...INVENTORY, x0: 34, y0: 1261, pitch: 82, icon: 72 } as const;
const INVENTORY_LAYOUTS = [INVENTORY, INVENTORY_WIDE] as const;
const MIN_INVENTORY_SCORE = 0.6; // for items that were on offer or are already owned
const SURE_INVENTORY_SCORE = 0.85; // for anything else
const MIN_INVENTORY_SD = 20; // raw pixel std-dev below which a slot counts as empty

export interface InventoryRead {
  slot: number;
  itemId: number;
  score: number;
  margin: number;
  sd: number;
}

/**
 * Item ids in the ten inventory slots (0 = empty or unreadable). `prefer` (every card offered this game + items already
 * owned) settles icon twins and lowers the score floor; an item outside it needs a near-perfect match.
 */
export function readInventory(img: RGBImage, index: DecodedIndex, prefer: number[] = []): InventoryRead[] {
  let best: InventoryRead[] = [];
  let bestN = -1;
  for (const layout of INVENTORY_LAYOUTS) {
    const r = readInventoryAt(img, index, prefer, layout);
    const n = r.filter((x) => x.itemId !== 0).length;
    if (n > bestN) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

function readInventoryAt(
  img: RGBImage,
  index: DecodedIndex,
  prefer: number[],
  INVENTORY: {
    x0: number;
    y0: number;
    pitch: number;
    icon: number;
    cols: number;
    rows: number;
    search: number;
    scales: readonly number[];
  },
): InventoryRead[] {
  const sx = img.width / BRAWL_LAYOUT.ref.width,
    sy = img.height / BRAWL_LAYOUT.ref.height;
  const out: InventoryRead[] = [];
  const pref = new Set(prefer);
  for (let r = 0; r < INVENTORY.rows; r++)
    for (let c = 0; c < INVENTORY.cols; c++) {
      const edge = INVENTORY.icon * sx;
      const cx = (INVENTORY.x0 + c * INVENTORY.pitch) * sx + edge / 2,
        cy = (INVENTORY.y0 + r * INVENTORY.pitch) * sy + edge / 2;
      // an empty slot is a flat tinted square: skip it on contrast before matching
      const raw = sampleSquare(img, cx - edge / 2, cy - edge / 2, edge, index.size);
      let s1 = 0,
        s2 = 0;
      for (const v of raw) {
        s1 += v;
        s2 += v * v;
      }
      const sd = Math.sqrt(Math.max(0, s2 / raw.length - (s1 / raw.length) ** 2));
      if (sd < MIN_INVENTORY_SD) {
        out.push({ slot: r * INVENTORY.cols + c, itemId: 0, score: 0, margin: 0, sd });
        continue;
      }
      const m = matchIcon(img, index, cx, cy, edge, undefined, {
        search: Math.round(INVENTORY.search * sx),
        scales: INVENTORY.scales,
      });
      let id = m.itemId;
      if (!pref.has(id)) {
        const tw = index.twins.get(id) ?? [];
        const p = tw.find((t) => pref.has(t));
        if (p) id = p;
      }
      // a background line through an empty slot can look like a dark streaky icon (Shadow Weave at 0.74 on the
      // screenshots), so an item nobody was offered needs a much better match than one that was
      if (m.score < (pref.has(id) ? MIN_INVENTORY_SCORE : SURE_INVENTORY_SCORE)) id = 0;
      out.push({ slot: r * INVENTORY.cols + c, itemId: id, score: m.score, margin: m.margin, sd });
    }
  return out;
}

/** Search window (2560x1440 ref px) that surely holds the "Use Re-Roll" button, whichever way the game lays it out. */
export const REROLL_SEARCH = { x0: 1080, y0: 870, x1: 1480, y1: 1030 } as const;

/**
 * Finds the "Use Re-Roll" pill's own outline in `rgba` (the REROLL_SEARCH window of the frame, `w`x`h` px, whose
 * top-left is (ox, oy) in frame px). The pill's top and bottom edges are the two long, light horizontal runs;
 * its left/right ends are the extreme light pixels of the middle rows (the label text never reaches them).
 * Returns the outline's rect in frame px, or null when no pill is found.
 */
export function findRerollButton(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  ox: number,
  oy: number,
  frameW: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.3 * rgba[i * 4]! + 0.59 * rgba[i * 4 + 1]! + 0.11 * rgba[i * 4 + 2]!;
  // per-row background: the 25th percentile of the row, so the frame's brown gradient does not count as "light"
  const light = new Uint8Array(w * h);
  const buf = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    buf.set(lum.subarray(y * w, (y + 1) * w));
    const med = [...buf].sort((a, b) => a - b)[w >> 2]!;
    for (let x = 0; x < w; x++) light[y * w + x] = lum[y * w + x]! > med + 20 ? 1 : 0;
  }
  const scale = frameW / BRAWL_LAYOUT.ref.width;
  const minRun = 90 * scale;
  const longest = (y: number) => {
    let best = 0,
      cur = 0;
    for (let x = 0; x < w; x++) {
      cur = light[y * w + x] ? cur + 1 : 0;
      if (cur > best) best = cur;
    }
    return best;
  };
  const rows: number[] = [];
  for (let y = 0; y < h; y++) if (longest(y) >= minRun) rows.push(y);
  if (rows.length < 2) return null;
  // group consecutive rows into bands (an edge is a few px thick); need a top band and a bottom band
  const bands: [number, number][] = [];
  for (const y of rows) {
    const last = bands[bands.length - 1];
    if (last && y - last[1] <= 2) last[1] = y;
    else bands.push([y, y]);
  }
  // choose the pair of bands whose gap best matches a button height (~65-100 ref px)
  let pair: [[number, number], [number, number]] | null = null;
  for (let i = 0; i < bands.length; i++)
    for (let j = i + 1; j < bands.length; j++) {
      const gap = (bands[j]![0] - bands[i]![1]) / scale;
      if (gap >= 55 && gap <= 105 && (!pair || bands[j]![0] - bands[i]![0] < pair[1][0] - pair[0][0]))
        pair = [bands[i]!, bands[j]!];
    }
  if (!pair) return null;
  const top = pair[0][0],
    bottom = pair[1][1];
  const mid0 = Math.round(top + (bottom - top) * 0.4),
    mid1 = Math.round(top + (bottom - top) * 0.6);
  let xMin = w,
    xMax = -1;
  // The ends are thin bright ridges (the outline is 2-3 px thick, brighter than both sides), so look for local
  // peaks: the frame's own glow beside the pill is light too, but never a ridge.
  const off = Math.max(3, Math.round(4 * scale));
  for (let y = mid0; y <= mid1; y++)
    for (let x = off; x < w - off; x++) {
      const v = lum[y * w + x]!;
      if (v - Math.max(lum[y * w + x - off]!, lum[y * w + x + off]!) > 18) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
    }
  if (xMax < xMin) return null;
  return { x0: ox + xMin, y0: oy + top, x1: ox + xMax + 1, y1: oy + bottom + 1 };
}
