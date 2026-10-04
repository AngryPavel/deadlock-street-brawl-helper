import { cardAnchors, readMarkers, type RGBImage, type CardRead } from '../brawl/recognise';
import { cardNameRegions, itemNameCrop, itemIdFromName } from './cardNames';
import { readItemName } from './cardNameOcr';

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
    const crops = reads.map((r, i) => (r.present ? null : itemNameCrop(img, regions[i]!)));
    const recovered = await Promise.all(
      reads.map(async (r, i) => {
        const crop = crops[i];
        if (!crop) return r;
        let id = 0;
        const cached = this.cache.get(crop.key);
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
          this.cache.set(crop.key, { id, expires: Date.now() + (id ? 60_000 : 2000) });
        }
        if (!id) return r;
        const a = anchors[i]!;
        const match = { ...r.match, itemId: id, x: a.cx - a.icon / 2, y: a.cy - a.icon / 2, edge: a.icon };
        return { ...r, itemId: id, present: true, tier: tiers[id] ?? 0, match, ...readMarkers(img, match) };
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
