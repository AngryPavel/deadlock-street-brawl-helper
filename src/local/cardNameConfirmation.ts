import { cardAnchors, type CardRead, type RGBImage } from '../brawl/recognise';
import { cardNameRegions, itemNameCrop } from './cardNames';
import { readItemName } from './cardNameOcr';

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Late correction requires exact independent text, unlike the ordinary fuzzy missing-icon fallback. */
export function exactCardNameId(text: string, confidence: number, names: Record<string, string>): number {
  const query = normalise(text);
  if (!Number.isFinite(confidence) || confidence < 80 || query.length < 4) return 0;
  const matches = Object.entries(names).filter(([, name]) => normalise(name) === query);
  return matches.length === 1 ? Number(matches[0]![0]) : 0;
}

export class CardNameConfirmation {
  private generation = 0;
  private cache = new Map<string, Promise<boolean>>();
  private readText: typeof readItemName;
  constructor(readText = readItemName) {
    this.readText = readText;
  }
  reset() {
    this.generation++;
    this.cache.clear();
  }
  async confirm(img: RGBImage, reads: CardRead[], names: Record<string, string>, candidate: string) {
    if (reads.length !== 3 || reads.some((r) => !r.present)) return false;
    const regions = cardNameRegions(img.width, img.height, cardAnchors(img.width, img.height));
    // Copy every crop before awaiting: the worker's shared frame buffer may be reused meanwhile.
    const crops = regions.map((r) => itemNameCrop(img, r));
    const signatures = crops.map((crop) => {
      let hash = 2166136261;
      for (let i = 0; i < crop.data.length; i += 4) hash = Math.imul(hash ^ crop.data[i]!, 16777619);
      return hash >>> 0;
    });
    const key = `${candidate}:${reads.map((r) => r.itemId).join(',')}:${signatures.join(',')}`;
    const previous = this.cache.get(key);
    if (previous) return previous;
    const generation = this.generation;
    const result = Promise.all(
      crops.map(async (crop, slot) => {
        try {
          const text = await this.readText(crop);
          return exactCardNameId(text.text, text.confidence, names) === reads[slot]!.itemId;
        } catch {
          return false;
        }
      }),
    ).then((agree) => generation === this.generation && agree.every(Boolean));
    if (this.cache.size >= 24) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
    return result;
  }
}
