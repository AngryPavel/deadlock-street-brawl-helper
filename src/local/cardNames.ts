import type { RGBImage, Region } from '../brawl/recognise';

const creamInk = (r: number, g: number, b: number) =>
  Math.min(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 85;

/** A missing name band cannot authorize a new offer, even when empty circles match an icon. */
export function hasItemNameInk(img: RGBImage, region: Region): boolean {
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++) {
      const s = (y * img.width + x) * img.channels;
      if (creamInk(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!)) return true;
    }
  return false;
}

/** Item-name bands below the icons; the ENHANCED badge is outside these rectangles. */
export function cardNameRegions(
  width: number,
  height: number,
  anchors: readonly { cx: number; cy: number; icon: number }[],
): Region[] {
  return anchors.map((a) => {
    const u = a.icon / 185;
    const x = Math.max(0, Math.floor(a.cx - 300 * u));
    const y = Math.max(0, Math.floor(a.cy + a.icon / 2 + 12 * u));
    return {
      x,
      y,
      width: Math.min(width, Math.ceil(a.cx + 300 * u)) - x,
      // Long tilted labels descend at the left edge; keep their complete glyphs before the badge below.
      height: Math.min(height, Math.ceil(a.cy + a.icon / 2 + 94 * u)) - y,
    };
  });
}

export function itemNameCrop(img: RGBImage, region: Region) {
  // Tilted names can touch the band edge; white air keeps OCR's line finder confident without adding evidence.
  const margin = 8,
    width = region.width + 2 * margin,
    height = region.height + 2 * margin;
  const data = new Uint8Array(width * height * 4).fill(255);
  let hash = 2166136261;
  for (let y = 0; y < region.height; y++)
    for (let x = 0; x < region.width; x++) {
      const s = ((region.y + y) * img.width + region.x + x) * img.channels;
      const i = ((y + margin) * width + x + margin) * 4;
      const lum = Math.round(0.299 * img.data[s]! + 0.587 * img.data[s + 1]! + 0.114 * img.data[s + 2]!);
      // Names are cream/white; remove the coloured card rings that otherwise look like extra letters.
      data[i] = data[i + 1] = data[i + 2] = creamInk(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!) ? 0 : 255;
      data[i + 3] = 255;
      hash = Math.imul(hash ^ lum, 16777619);
    }
  return { data, width, height, key: `${width}:${height}:${hash}` };
}

/** Preserve the edges of thin glyphs on a second pass, using the bright text to exclude nearby card art. */
export function itemNameSoftCrop(img: RGBImage, region: Region) {
  let left = region.width,
    top = region.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < region.height; y++)
    for (let x = 0; x < region.width; x++) {
      const s = ((region.y + y) * img.width + region.x + x) * img.channels;
      if (!creamInk(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right < left) return null;
  left = Math.max(0, left - 2);
  top = Math.max(0, top - 2);
  right = Math.min(region.width - 1, right + 2);
  bottom = Math.min(region.height - 1, bottom + 2);
  const margin = 16,
    width = right - left + 1 + margin * 2,
    height = bottom - top + 1 + margin * 2;
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let y = top; y <= bottom; y++)
    for (let x = left; x <= right; x++) {
      const s = ((region.y + y) * img.width + region.x + x) * img.channels;
      const low = Math.min(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!);
      const high = Math.max(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!);
      // Keep the faint antialiased strokes between narrow neighboring letters.
      const value = high - low < 85 ? 255 - Math.max(0, Math.min(255, ((low - 90) * 255) / 125)) : 255;
      const i = ((y - top + margin) * width + x - left + margin) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
  // Integer nearest enlargement preserves these antialiased pixels equally in Canvas and Sharp.
  // Browser bilinear enlargement can blur two neighboring narrow glyphs into a low-confidence word.
  return { data, width, height, scale: 4, interpolation: 'nearest' as const };
}

const normaliseName = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};

/** Resolve only an exact or clearly separated near-match; unread/ambiguous text stays unknown. */
export function itemIdFromName(text: string, confidence: number, names: Record<string, string>): number {
  const query = normaliseName(text);
  if (query.length < 4 || confidence < 45) return 0;
  const scores = Object.entries(names)
    .map(([id, name]) => {
      const key = normaliseName(name);
      return { id: Number(id), score: 1 - distance(query, key) / Math.max(query.length, key.length) };
    })
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best) return 0;
  if (best.score === 1) return best.id;
  return best.score >= 0.88 && best.score - (scores[1]?.score ?? 0) >= 0.1 ? best.id : 0;
}
