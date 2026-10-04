import type { RGBImage } from '../brawl/recognise';
import { ROUND_COUNTDOWN_INK } from './roundCountdownTemplate';

// Measured from the user's 3439 x 1439 first-round preparation frame. This caption belongs to the
// right edge, unlike the centred draft HUD. The green changing numeral is deliberately excluded.
const CAPTION = { right: 405, top: 390, width: 364, height: 23, referenceHeight: 1439 };
const TW = 182;
const TH = 12;
const TEMPLATE_INK = ROUND_COUNTDOWN_INK.reduce((sum, row) => sum + [...row].filter((v) => v === '1').length, 0);
const warmInk = (r: number, g: number, b: number) => r >= 165 && g >= 145 && b >= 115 && r >= g && g >= b && r - b < 65;

export function roundCountdownRegion(width: number, height: number) {
  const s = height / CAPTION.referenceHeight;
  const x = Math.max(0, Math.floor(width - (CAPTION.right + 130) * s));
  const y = Math.max(0, Math.floor((CAPTION.top - 7) * s));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, Math.ceil(width - (CAPTION.right - CAPTION.width - 10) * s)) - x),
    height: Math.max(0, Math.min(height, Math.ceil((CAPTION.top + CAPTION.height + 7) * s)) - y),
  };
}

/** Match the fixed English caption, never the changing seconds. Only this small crop is thresholded;
 * integral ink samples tolerate antialiasing and the slight font scaling differences of capture. */
export function hasRoundCountdown(img: RGBImage): boolean {
  const width = img.origin?.fullWidth ?? img.width;
  const height = img.origin?.fullHeight ?? img.height;
  const requested = roundCountdownRegion(width, height);
  const ox = img.origin?.x ?? 0;
  const oy = img.origin?.y ?? 0;
  const region = {
    x: Math.max(requested.x, ox),
    y: Math.max(requested.y, oy),
    width: Math.min(requested.x + requested.width, ox + img.width) - Math.max(requested.x, ox),
    height: Math.min(requested.y + requested.height, oy + img.height) - Math.max(requested.y, oy),
  };
  if (region.width <= 0 || region.height <= 0) return false;
  const stride = region.width + 1;
  const integral = new Uint32Array(stride * (region.height + 1));
  const columns = new Uint16Array(region.width);
  for (let y = 0; y < region.height; y++) {
    let row = 0;
    for (let x = 0; x < region.width; x++) {
      const i = ((region.y + y - oy) * img.width + region.x + x - ox) * img.channels;
      const lit = Number(warmInk(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!));
      row += lit;
      columns[x] += lit;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + row;
    }
  }
  const s = height / CAPTION.referenceHeight;
  const x0 = width - CAPTION.right * s - region.x;
  const y0 = CAPTION.top * s - region.y;
  const slack = Math.max(1, Math.round(2 * s));
  // The game's caption moves horizontally with its countdown layout. Find word-band starts only
  // inside this bounded right-hand strip, then retain the same complete fixed-text template gate.
  const starts = [x0];
  let previous = -Infinity;
  for (let x = 0; x < columns.length; x++)
    if (columns[x]) {
      if (x - previous > 14 * s && x + CAPTION.width * 0.98 * s <= region.width + slack) starts.push(x);
      previous = x;
    }
  for (const start of starts)
    for (const scale of [1, 0.98, 1.02])
      for (let dy = -slack; dy <= slack; dy++)
        for (let dx = -slack; dx <= slack; dx++) {
          let ink = 0,
            overlap = 0;
          for (let y = 0; y < TH; y++)
            for (let x = 0; x < TW; x++) {
              const xa = Math.max(0, Math.round(start + dx + (x * CAPTION.width * s * scale) / TW));
              const xb = Math.min(
                region.width,
                Math.max(xa + 1, Math.round(start + dx + ((x + 1) * CAPTION.width * s * scale) / TW)),
              );
              const ya = Math.max(0, Math.round(y0 + dy + (y * CAPTION.height * s * scale) / TH));
              const yb = Math.min(
                region.height,
                Math.max(ya + 1, Math.round(y0 + dy + ((y + 1) * CAPTION.height * s * scale) / TH)),
              );
              if (xa >= region.width || ya >= region.height || xb <= xa || yb <= ya) continue;
              const count =
                integral[yb * stride + xb]! -
                integral[ya * stride + xb]! -
                integral[yb * stride + xa]! +
                integral[ya * stride + xa]!;
              const lit = count / ((xb - xa) * (yb - ya)) >= 0.4;
              if (lit) {
                ink++;
                if (ROUND_COUNTDOWN_INK[y]![x] === '1') overlap++;
              }
            }
          if ((2 * overlap) / (TEMPLATE_INK + ink) >= 0.8) return true;
        }
  return false;
}

/** A confirmed first draft arms the preparation interval. Brief missing cues are tolerated, then the
 * interval ends permanently for this match; reset only for a verified new match or capture restart. */
export class FirstRoundPreparation {
  visible = false;
  private ended = false;
  private lastSeen: number | null = null;
  private laterRound = 0;
  private laterSamples = 0;
  private lastLaterSample: number | undefined;
  reset() {
    this.visible = false;
    this.ended = false;
    this.lastSeen = null;
    this.laterRound = this.laterSamples = 0;
    this.lastLaterSample = undefined;
  }
  observe(
    {
      shop,
      round,
      countdown,
      confirmedRound = false,
      sample,
    }: {
      shop: boolean;
      round: number;
      countdown: boolean;
      confirmedRound?: boolean;
      sample?: number;
    },
    now: number,
  ): boolean {
    if (round > 1) {
      if (round !== this.laterRound) {
        this.laterRound = round;
        this.laterSamples = 0;
        this.lastLaterSample = undefined;
      }
      if (sample === undefined || sample !== this.lastLaterSample) {
        this.laterSamples++;
        this.lastLaterSample = sample;
      }
      // A raw top glyph can misread for one frame. Only a committed shop context or two independent
      // consistent observations may end this match's first preparation irreversibly.
      if (confirmedRound || this.laterSamples >= 2) {
        this.visible = false;
        this.ended = true;
      }
      return this.visible;
    }
    this.laterRound = this.laterSamples = 0;
    this.lastLaterSample = undefined;
    if (this.ended) return false;
    if (round === 1 && (shop || countdown)) {
      this.lastSeen = now;
      this.visible = true;
    } else if (this.visible && countdown) this.lastSeen = now;
    else if (this.visible && this.lastSeen !== null && now - this.lastSeen >= 600) {
      this.visible = false;
      this.ended = true;
    }
    return this.visible;
  }
}
