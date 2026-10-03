import type { CardRead } from './recognise';
import { rerollButtonRect } from './recognise';
import type { AbilityPanelData } from './abilities';
import type { DotState } from './lobbyDot';

export interface OverlayAdviceCard {
  itemId: number;
  name: string;
  score: number;
  enhanced: boolean;
  usage: number;
  winRate: number | null;
  /** Tier-list letter ("S".."C"), "-" when the item has none. */
  grade: string;
  /** Tooltip rows: fixed labels and hundredths (see `breakdownRows`); one "No Street Brawl data" row without data. */
  rows: { label: string; cents: number }[];
}

/** Everything the overlay panel needs to render the same advice as the pop-out, without alt-tabbing:
 *  names not ids, since the overlay window has no access to the item/ability catalog. */
export interface OverlayAdvice {
  hero: string;
  round: number;
  choice: number;
  reroll: { expectedBest: number; currentBest: number } | null;
  ranked: OverlayAdviceCard[];
  status: string;
}

/** Everything the overlay may draw. It draws nothing at all unless `draft` (the item draft screen is on the
 *  frame) or `panel` (the ability panel window is running); see `overlayHasContent`. */
export interface OverlayState {
  reads: CardRead[];
  bestId: number | null;
  reroll: boolean;
  frameW: number;
  frameH: number;
  advice: OverlayAdvice | null;
  draft: boolean;
  panel: AbilityPanelData | null;
  /** The "Use Re-Roll" pill's outline found on the frame (frame px); absent: the nominal layout rect. */
  rerollRect?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** The lobby status dot (set by the main process, not the control window): absent while in a match. */
  dot?: DotState | null;
}

/** The blank state: nothing to draw. */
export const BLANK_OVERLAY: OverlayState = {
  reads: [],
  bestId: null,
  reroll: false,
  frameW: 0,
  frameH: 0,
  advice: null,
  draft: false,
  panel: null,
};

export { overlayHasContent } from './overlayContent';

/** One shape `drawReads` actually stroked, in capture-frame px (unscaled by scaleX/scaleY) — so a caller that
 *  knows the canvas's own scale relative to the frame can turn these back into canvas px, and something that
 *  only has frame-px labels (e.g. the e2e harness comparing against `scripts/win/frames/labels.json`) can
 *  compare directly without redoing the scale math. For cards the rect is the bounding box of the large
 *  circle the item sits in; `score` is the number drawn above it (null for the re-roll box). */
export interface DrawnRect {
  kind: 'card' | 'best' | 'reroll';
  itemId: number | null;
  card: string | null; // read.card ("left"/"top"/"right") for card/best, null for reroll
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number | null;
  /** The plate above the card (frame px); null for the re-roll box or a card without a score. */
  plate: FrameRect | null;
}

// The large circle an item sits in, relative to the small icon square the recogniser matches: measured on
// the 2000x1125 reference frames (icon edge ~137px, circle diameter ~352px, circle centre ~37px below the
// icon's centre), so everything scales with the matched icon edge.
const CIRCLE_RADIUS_PER_EDGE = 1.285;
const CIRCLE_CENTRE_DROP_PER_EDGE = 0.27;

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** The circle around an item, in the same px space as `match` (frame px). */
export function itemCircle(match: { x: number; y: number; edge: number }): Circle {
  return {
    cx: match.x + match.edge / 2,
    cy: match.y + match.edge / 2 + match.edge * CIRCLE_CENTRE_DROP_PER_EDGE,
    r: match.edge * CIRCLE_RADIUS_PER_EDGE,
  };
}

/** Overlay palette (charcoal + teal). The CSS variables in `src/index.css` are the source; these are the same values
 *  for the canvas, read from the document when there is one. */
export interface OverlayTheme {
  panel: string;
  teal: string;
  tealInk: string;
  text: string;
  muted: string;
}
const DEFAULT_THEME: OverlayTheme = {
  panel: 'rgba(16,19,20,0.85)',
  teal: '#2ec4b6',
  tealInk: '#06201d',
  text: '#ece6da',
  muted: '#a39e92',
};
function readTheme(): OverlayTheme {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return DEFAULT_THEME;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    panel: v('--overlay-panel', DEFAULT_THEME.panel),
    teal: v('--teal', DEFAULT_THEME.teal),
    tealInk: v('--teal-ink', DEFAULT_THEME.tealInk),
    text: v('--text', DEFAULT_THEME.text),
    muted: v('--muted', DEFAULT_THEME.muted),
  };
}

export interface FrameRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** Draws the plate above every offered card (tier badge + `Score: <n>`) and the 3 px teal outline around the best card,
 *  scaled from capture-frame pixels to the target canvas size. Shared by the preview canvas (BrawlView) and the Electron
 *  overlay window. The best card's plate is filled teal with dark text, the others are charcoal with a thin teal border
 *  and muted text. When `reroll` is true no card is best (the engine says re-roll, not take) and the "Use Re-Roll"
 *  button is boxed instead. `scores`/`grades` map itemId to what the advice shows. Returns every shape drawn, in frame
 *  px, for callers (the hover tooltip, the e2e harness) that need to know where things landed. */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  reads: CardRead[],
  bestId: number | null,
  scaleX: number,
  scaleY: number,
  frameW: number,
  frameH: number,
  reroll = false,
  scores: Record<number, number> = {},
  rerollRect: FrameRect | null = null,
  grades: Record<number, string> = {},
  theme: OverlayTheme = readTheme(),
): DrawnRect[] {
  const drawn: DrawnRect[] = [];
  for (const read of reads) {
    if (!read.present) continue;
    const isBest = !reroll && read.itemId === bestId;
    const { cx, cy, r } = itemCircle(read.match);
    const box = { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
    if (isBest) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.teal;
      ctx.beginPath();
      ctx.ellipse(cx * scaleX, cy * scaleY, r * scaleX, r * scaleY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const score = scores[read.itemId];
    let plate: FrameRect | null = null;
    if (score !== undefined) {
      const font = Math.max(14, Math.round(read.match.edge * 0.2 * scaleY));
      const h = Math.round(font * 1.7);
      const label = `Score: ${score.toFixed(2)}`;
      ctx.font = `bold ${font}px sans-serif`;
      const textW = ctx.measureText(label).width;
      const pad = Math.round(font * 0.5);
      const w = Math.round(h + textW + pad * 2);
      const x = Math.round(cx * scaleX - w / 2);
      const y = Math.max(2, Math.round(box.y0 * scaleY - h - Math.max(4, read.match.edge * 0.04 * scaleY)));
      ctx.fillStyle = isBest ? theme.teal : theme.panel;
      roundedRect(ctx, x, y, w, h, 4);
      ctx.fill();
      if (!isBest) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.teal;
        roundedRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
        ctx.stroke();
      }
      // tier badge: a square at the left end, a darker cell so the letter reads at a glance
      ctx.fillStyle = isBest ? theme.tealInk : theme.teal;
      roundedRect(ctx, x + 2, y + 2, h - 4, h - 4, 3);
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillStyle = isBest ? theme.teal : theme.tealInk;
      ctx.fillText(grades[read.itemId] ?? '-', x + h / 2, y + h / 2 + 1);
      ctx.textAlign = 'start';
      ctx.fillStyle = isBest ? theme.tealInk : theme.muted;
      ctx.fillText(label, x + h + pad, y + h / 2 + 1);
      ctx.textBaseline = 'alphabetic';
      plate = { x0: x / scaleX, y0: y / scaleY, x1: (x + w) / scaleX, y1: (y + h) / scaleY };
    }
    drawn.push({
      kind: isBest ? 'best' : 'card',
      itemId: read.itemId,
      card: read.card,
      ...box,
      score: score ?? null,
      plate,
    });
  }
  if (reroll) {
    const rect = rerollRect ?? rerollButtonRect(frameW, frameH);
    const x0 = rect.x0 * scaleX,
      y0 = rect.y0 * scaleY,
      x1 = rect.x1 * scaleX,
      y1 = rect.y1 * scaleY;
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.teal;
    roundedRect(ctx, x0, y0, x1 - x0, y1 - y0, 4);
    ctx.stroke();
    ctx.font = 'bold 14px sans-serif';
    const w = ctx.measureText('RE-ROLL').width + 16;
    const ly = Math.max(2, y0 - 28);
    ctx.fillStyle = theme.panel;
    roundedRect(ctx, x0, ly, w, 24, 4);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.teal;
    roundedRect(ctx, x0 + 0.5, ly + 0.5, w - 1, 23, 4);
    ctx.stroke();
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'middle';
    ctx.fillText('RE-ROLL', x0 + 8, ly + 13);
    ctx.textBaseline = 'alphabetic';
    drawn.push({
      kind: 'reroll',
      itemId: null,
      card: null,
      x0: rect.x0,
      y0: rect.y0,
      x1: rect.x1,
      y1: rect.y1,
      score: null,
      plate: null,
    });
  }
  return drawn;
}

/** itemId -> tier letter map from the advice ranking. */
export function gradesFromAdvice(advice: OverlayAdvice | null): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.grade;
  return out;
}

/** itemId -> score map from the advice ranking, so drawn scores are exactly the panel's numbers. */
export function scoresFromAdvice(advice: OverlayAdvice | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.score;
  return out;
}

/** Where the lobby status dot sits on a canvas of this height: ~10 px diameter and a 12 px margin at 1080p. */
function dotGeometry(canvasH: number) {
  const k = canvasH / 1080;
  const r = (10 * k) / 2;
  return { cx: 12 * k + r, cy: 12 * k + r, r };
}
const DOT_COLORS: Record<DotState, string> = { watching: '', reading: '#f0a830', failed: '#8a9092' };
const DOT_WORD: Record<DotState, string> = {
  watching: 'Watching for the draft',
  reading: 'Reading the draft',
  failed: 'Capture failed',
};
// Deadlock bolt from public/favicon.svg (48 x 45 box)
const BOLT =
  'M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z';

/** The lobby badge's rectangle (logo, title and status line around the dot) on a canvas of this height. */
export function dotBadgeRect(canvasH: number) {
  const k = canvasH / 1080;
  return { x: 4 * k, y: 1 * k, w: 232 * k, h: 32 * k };
}

/** Draws the lobby badge: status dot (teal watching / amber reading / grey failed), the bolt logo, the
 *  "STREET BRAWL ADVISOR" title and a status line; returns what it drew (the dot, as before). */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  state: DotState,
  canvasH: number,
  theme: OverlayTheme = readTheme(),
  pulse = 0,
) {
  const g = dotGeometry(canvasH);
  const k = canvasH / 1080;
  const color = DOT_COLORS[state] || theme.teal;
  const b = dotBadgeRect(canvasH);
  ctx.save();
  // plate: charcoal with a thin teal border
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = theme.panel;
  ctx.strokeStyle = theme.teal;
  ctx.lineWidth = Math.max(1, k);
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, 4 * k);
  ctx.fill();
  ctx.stroke();
  // status dot
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
  ctx.fill();
  if (state === 'reading') {
    // a ring that grows and fades (`pulse` runs 0..1): the app is working on a frame
    ctx.globalAlpha = 0.6 * (1 - pulse);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, g.r * 0.35);
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r * (1 + 0.5 * pulse), 0, Math.PI * 2);
    ctx.stroke();
  }
  // logo
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(28 * k, 6 * k);
  ctx.scale((20 * k) / 48, (20 * k) / 48);
  ctx.fillStyle = theme.teal;
  ctx.fill(new Path2D(BOLT));
  ctx.restore();
  // title + status line
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.text;
  ctx.font = `bold ${13 * k}px sans-serif`;
  ctx.fillText('STREET BRAWL ADVISOR', 54 * k, 15 * k);
  ctx.fillStyle = theme.muted;
  ctx.font = `${10.5 * k}px sans-serif`;
  ctx.fillText(`${DOT_WORD[state]} · F8`, 54 * k, 27.5 * k);
  ctx.restore();
  return { ...g, color, state };
}
