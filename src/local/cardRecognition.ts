import { cardAnchors, readMarkers, type RGBImage, type CardRead } from '../brawl/recognise';
import { cardNameRegions, itemNameCrop, itemIdFromName, hasItemNameInk } from './cardNames';
import { readItemName } from './cardNameOcr';

/** A missing index entry is recoverable, but a uniform empty icon core is not a visible card. */
function hasIconPixels(img: RGBImage, anchor: { cx: number; cy: number; icon: number }): boolean {
  let low = 255,
    high = 0;
  // Stay well inside the icon: a coloured circle/border alone cannot supply this evidence.
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 12; x++) {
      const px = Math.round(anchor.cx + ((x + 0.5) / 12 - 0.5) * anchor.icon * 0.6);
      const py = Math.round(anchor.cy + ((y + 0.5) / 12 - 0.5) * anchor.icon * 0.6);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const offset = (py * img.width + px) * img.channels;
      const value = (img.data[offset]! + img.data[offset + 1]! + img.data[offset + 2]!) / 3;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  return high - low > 16;
}

/** Fallback stays outside the original pixel recogniser. Crops are copied before awaiting OCR. */
export class CardNameRecovery {
  generation = 0;
  private cache = new Map<string, { id: number; expires: number }>();
  private readText: typeof readItemName;
  constructor(readText = readItemName) {
    this.readText = readText;
  }
  reset() {
    this.generation++;
    this.cache.clear();
  }

  async recover(img: RGBImage, reads: CardRead[], names: Record<string, string>, tiers: Record<number, number>) {
    const generation = this.generation;
    const anchors = cardAnchors(img.width, img.height);
    const regions = cardNameRegions(img.width, img.height, anchors);
    const crops = reads.map((r, i) =>
      r.present || !hasItemNameInk(img, regions[i]!) || !hasIconPixels(img, anchors[i]!)
        ? null
        : itemNameCrop(img, regions[i]!),
    );
    const catalog = JSON.stringify(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)));
    const recovered = await Promise.all(
      reads.map(async (r, i) => {
        const crop = crops[i];
        if (!crop) return r;
        let id = 0;
        const key = `${catalog}:${crop.key}`;
        const cached = this.cache.get(key);
        if (cached && cached.expires > Date.now()) id = cached.id;
        else {
          try {
            const text = await this.readText(crop);
            id = itemIdFromName(text.text, text.confidence, names);
          } catch {
            return r;
          }
          if (generation !== this.generation) return r;
          if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { id, expires: Date.now() + (id ? 60_000 : 2000) });
        }
        if (!id) return r;
        const a = anchors[i]!;
        const match = { ...r.match, itemId: id, x: a.cx - a.icon / 2, y: a.cy - a.icon / 2, edge: a.icon };
        return {
          ...r,
          itemId: id,
          present: true,
          tier: tiers[id] ?? 0,
          match,
          ...readMarkers(img, match),
        };
      }),
    );
    return generation === this.generation ? recovered : reads;
  }
}

/** OCR may take several frames. Serialise draft reads while still accepting stop/reset control messages. */
export function serialFrames<T extends { type: string }>(
  handle: (ev: MessageEvent<T>) => Promise<void>,
  retry: () => void,
) {
  let busy = false;
  return async (ev: MessageEvent<T>) => {
    if (ev.data.type !== 'frame') return handle(ev);
    if (busy) {
      retry();
      return;
    }
    busy = true;
    try {
      await handle(ev);
    } finally {
      busy = false;
    }
  };
}
