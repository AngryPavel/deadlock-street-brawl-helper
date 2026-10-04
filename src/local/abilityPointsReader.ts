import { hudLayout } from './hudLayout';
import { readItemName } from './cardNameOcr';
import type { RGBImage } from '../brawl/recognise';
import type { AbilityPoints } from './abilityTipPolicy';

/** Counter only, to the right of the diamond below the four ability icons. */
export function abilityPointsRect(width: number, height: number) {
  const { sx, sy, offsetX } = hudLayout(width, height);
  const x = Math.round(offsetX + 1280 * sx),
    y = Math.round(1402 * sy);
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(65 * sx))), height: Math.max(1, height - y) };
}
export function abilityPointsGlyph(img: RGBImage) {
  const mask = new Uint8Array(img.width * img.height);
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels,
        r = img.data[i]!,
        g = img.data[i + 1]!,
        b = img.data[i + 2]!;
      const on = (g > 75 && g > r * 1.03 && g > b * 1.1) || (r > 100 && b > 120 && g < r * 0.93 && b > r * 0.98);
      if (on) {
        mask[y * img.width + x] = 1;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  if (x1 < x0 || y1 - y0 < 5) return null;
  const width = x1 - x0 + 1,
    height = y1 - y0 + 1;
  // The HUD font's oval zero is routinely rejected by Tesseract. A tall centred enclosed hole
  // identifies it without confusing the short/off-centre holes of 6/9 or the two holes of 8.
  if (width / height < 1.05) {
    const visited = new Uint8Array(mask.length);
    const holes: { y0: number; y1: number }[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * img.width + x;
        if (mask[i] || visited[i]) continue;
        const stack = [i];
        visited[i] = 1;
        let edge = false,
          minY = y,
          maxY = y,
          count = 0;
        while (stack.length) {
          const p = stack.pop()!,
            px = p % img.width,
            py = Math.floor(p / img.width);
          count++;
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
          if (px === x0 || px === x1 || py === y0 || py === y1) edge = true;
          for (const [qx, qy] of [
            [px - 1, py],
            [px + 1, py],
            [px, py - 1],
            [px, py + 1],
          ]) {
            if (qx < x0 || qx > x1 || qy < y0 || qy > y1) continue;
            const q = qy * img.width + qx;
            if (!mask[q] && !visited[q]) {
              visited[q] = 1;
              stack.push(q);
            }
          }
        }
        if (!edge && count > 3) holes.push({ y0: minY, y1: maxY });
      }
    if (
      holes.length === 1 &&
      holes[0].y1 - holes[0].y0 + 1 >= height * 0.42 &&
      Math.abs((holes[0].y0 + holes[0].y1 - y0 - y1) / 2) <= height * 0.13
    )
      return { zero: true as const };
  }
  // Infinity is one connected wide glyph. Two separate digits (e.g. 32) must remain numeric.
  if (width / height > 1.55) {
    const visited = new Uint8Array(mask.length);
    let large = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || visited[i]) continue;
      const stack = [i];
      visited[i] = 1;
      let count = 0;
      while (stack.length) {
        const p = stack.pop()!;
        count++;
        const x = p % img.width,
          y = Math.floor(p / img.width);
        for (const q of [
          x > 0 ? p - 1 : -1,
          x < img.width - 1 ? p + 1 : -1,
          y > 0 ? p - img.width : -1,
          y < img.height - 1 ? p + img.width : -1,
        ]) {
          if (q >= 0 && mask[q] && !visited[q]) {
            visited[q] = 1;
            stack.push(q);
          }
        }
      }
      if (count > height) large++;
    }
    if (large === 1) return { infinite: true as const };
  }
  const pad = 6,
    outW = width + pad * 2,
    outH = height + pad * 2,
    data = new Uint8Array(outW * outH * 4).fill(255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!mask[(y + y0) * img.width + x + x0]) continue;
      const i = ((y + pad) * outW + x + pad) * 4;
      data[i] = data[i + 1] = data[i + 2] = 0;
    }
  return { data, width: outW, height: outH };
}
let lastGlyph = '';
let lastPoints: AbilityPoints = null;
export async function readAbilityPoints(img: RGBImage): Promise<AbilityPoints> {
  const glyph = abilityPointsGlyph(img);
  if (!glyph) return null;
  if ('zero' in glyph) return 0;
  if ('infinite' in glyph) return 'infinite';
  // The coloured HUD glyph is independent of the moving scene behind it. Reuse a successful OCR
  // read until its pixels change, while the reader still requires two separate frame confirmations.
  let signature = `${glyph.width}x${glyph.height}:`;
  for (let i = 0; i < glyph.data.length; i += 4) signature += glyph.data[i] === 0 ? '1' : '0';
  if (signature === lastGlyph) return lastPoints;
  const { text, confidence } = await readItemName(glyph, true);
  const digits = text.trim();
  const points = confidence >= 45 && /^\d{1,2}$/.test(digits) && Number(digits) <= 64 ? Number(digits) : null;
  if (points !== null) {
    lastGlyph = signature;
    lastPoints = points;
  }
  return points;
}

/** Confirm changes twice, never turn missing evidence into a zero, and discard OCR from an old tip. */
export class AbilityPointsReader {
  private generation = 0;
  private busy = false;
  private nextAt = 0;
  private candidate: AbilityPoints = null;
  private hits = 0;
  value: AbilityPoints = null;
  private read: typeof readAbilityPoints;
  constructor(read = readAbilityPoints) {
    this.read = read;
  }
  reset() {
    this.generation++;
    this.value = this.candidate = null;
    this.hits = 0;
    this.nextAt = 0;
  }
  poll(img: RGBImage, now: number, emit: (points: AbilityPoints) => void) {
    if (this.busy || now < this.nextAt) return;
    const generation = this.generation;
    this.busy = true;
    this.nextAt = now + 500;
    void this.read(img)
      .catch(() => null)
      .then((value) => {
        if (generation !== this.generation || value === null) return;
        this.hits = this.candidate === value ? this.hits + 1 : 1;
        this.candidate = value;
        if (this.hits >= 2 && value !== this.value) {
          this.value = value;
          emit(value);
        }
      })
      .finally(() => {
        this.busy = false;
      });
  }
}
