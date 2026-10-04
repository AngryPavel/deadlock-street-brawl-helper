import { cardAnchors, readMarkers, type CardRead, type RGBImage } from '../brawl/recognise';
import { cardNameRegions, itemNameCrop, itemNameSoftCrop } from './cardNames';
import { readItemName, type ItemNameOcrCrop } from './cardNameOcr';

export const strongDirectCard = (read: CardRead) =>
  read.present && read.match?.score >= 0.82 && read.match.margin >= 0.08;

const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Late correction requires exact independent text, unlike the ordinary fuzzy missing-icon fallback. */
export function exactCardNameId(text: string, confidence: number, names: Record<string, string>): number {
  const query = normalise(text);
  if (!Number.isFinite(confidence) || confidence < 80 || query.length < 4) return 0;
  const matches = Object.entries(names).filter(([, name]) => normalise(name) === query);
  return matches.length === 1 ? Number(matches[0]![0]) : 0;
}

export interface CardNameTextEvidence {
  text: string;
  confidence: number;
  cropSignature: string;
}
export interface CardNameSlotOutcome {
  slot: number;
  status: 'strong' | 'exact' | 'unknown' | 'unavailable';
  itemId: number;
  reason?:
    'empty-text' | 'low-confidence' | 'non-finite-confidence' | 'ambiguous-name' | 'non-exact-name' | 'service-failed';
  primary?: CardNameTextEvidence;
  alternate?: CardNameTextEvidence;
}
export interface CardNameConfirmationOutcome {
  candidate: string;
  evidenceKey: string;
  slots: readonly CardNameSlotOutcome[];
}
export type CardNameOutcome = CardNameConfirmationOutcome;

function unknownReason(text: CardNameTextEvidence, names: Record<string, string>): CardNameSlotOutcome['reason'] {
  if (!Number.isFinite(text.confidence)) return 'non-finite-confidence';
  if (text.confidence < 80) return 'low-confidence';
  const query = normalise(text.text);
  if (query.length < 4) return 'empty-text';
  return Object.values(names).filter((name) => normalise(name) === query).length > 1
    ? 'ambiguous-name'
    : 'non-exact-name';
}

export class CardNameConfirmation {
  private generation = 0;
  private cache = new Map<string, { result: Promise<CardNameSlotOutcome>; retryAt: number }>();
  private activeEvidenceKey = '';
  private outcome: CardNameConfirmationOutcome | null = null;
  private readText: typeof readItemName;
  constructor(readText = readItemName) {
    this.readText = readText;
  }
  reset() {
    this.generation++;
    this.cache.clear();
    this.activeEvidenceKey = '';
    this.outcome = null;
  }
  /** Only complete current evidence is exposed; old capture jobs cannot publish diagnostics. */
  getOutcome(candidate: string): CardNameConfirmationOutcome | null {
    return this.outcome?.candidate === candidate && this.outcome.evidenceKey === this.activeEvidenceKey
      ? this.outcome
      : null;
  }
  async confirm(
    img: RGBImage,
    reads: CardRead[],
    names: Record<string, string>,
    candidate: string,
    direct = reads.map(strongDirectCard),
  ) {
    const resolved = await this.resolve(img, reads, names, {}, candidate, direct);
    return !!resolved && resolved.every((r, slot) => r.itemId === reads[slot]!.itemId);
  }

  /** Exact text can replace a weak present icon ID; strong slots and raw match strength stay unchanged. */
  async resolve(
    img: RGBImage,
    reads: CardRead[],
    names: Record<string, string>,
    tiers: Record<number, number>,
    candidate: string,
    direct = reads.map(strongDirectCard),
  ): Promise<CardRead[] | null> {
    if (reads.length !== 3 || reads.some((r) => !r.present)) return null;
    const anchors = cardAnchors(img.width, img.height);
    const regions = cardNameRegions(img.width, img.height, anchors);
    // Copy every crop before awaiting: the worker's shared frame buffer may be reused meanwhile.
    const crops = regions.map((r) => itemNameCrop(img, r));
    const softCrops = regions.map((r, slot) => (direct[slot] ? null : itemNameSoftCrop(img, r)));
    const signature = (crop: ItemNameOcrCrop) => {
      let hash = 2166136261;
      for (let i = 0; i < crop.data.length; i += 4) hash = Math.imul(hash ^ crop.data[i]!, 16777619);
      return `${crop.width}:${crop.height}:${crop.scale ?? 3}:${crop.interpolation ?? 'smooth'}:${hash >>> 0}`;
    };
    // Antialiased edges can change while the primary binary mask stays identical.
    const signatures = crops.map(
      (crop, slot) => `${signature(crop)}/${softCrops[slot] ? signature(softCrops[slot]) : ''}`,
    );
    const strong = direct;
    const key = `${candidate}:${strong.map(Number).join('')}:${reads.map((r) => r.itemId).join(',')}:${signatures.join(',')}`;
    this.activeEvidenceKey = key;
    const generation = this.generation;
    const outcomes = await Promise.all(
      crops.map((crop, slot): Promise<CardNameSlotOutcome> => {
        if (strong[slot]) return Promise.resolve({ slot, status: 'strong', itemId: reads[slot]!.itemId });
        // A changed neighbor must not repeat an already completed read of identical slot pixels.
        const slotKey = `${candidate}:${slot}:${signatures[slot]}`;
        const previous = this.cache.get(slotKey);
        if (previous && previous.retryAt > Date.now()) return previous.result;
        const entry = { result: null as unknown as Promise<CardNameSlotOutcome>, retryAt: Infinity };
        entry.result = (async (): Promise<CardNameSlotOutcome> => {
          let primary: CardNameTextEvidence | undefined;
          try {
            const text = await this.readText(crop);
            primary = Object.freeze({ ...text, cropSignature: signature(crop) });
            const exact = exactCardNameId(text.text, text.confidence, names);
            if (exact) return { slot, status: 'exact', itemId: exact, primary };
            if (generation !== this.generation || !softCrops[slot])
              return { slot, status: 'unknown', itemId: 0, reason: unknownReason(primary, names), primary };
            // One alternate preprocessing pass; the exact unique name/confidence gate stays identical.
            const retry = await this.readText(softCrops[slot]!);
            const alternate = Object.freeze({ ...retry, cropSignature: signature(softCrops[slot]!) });
            const itemId = exactCardNameId(retry.text, retry.confidence, names);
            return itemId
              ? { slot, status: 'exact', itemId, primary, alternate }
              : { slot, status: 'unknown', itemId: 0, reason: unknownReason(alternate, names), primary, alternate };
          } catch {
            // Only transient service failures repeat unchanged evidence. Completed unknown text is final
            // until pixels change or reset/F8 starts a new capture generation.
            entry.retryAt = Date.now() + 1000;
            return { slot, status: 'unavailable', itemId: 0, reason: 'service-failed', primary };
          }
        })();
        if (this.cache.size >= 72) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(slotKey, entry);
        return entry.result;
      }),
    );
    if (generation !== this.generation) return null;
    if (key === this.activeEvidenceKey)
      this.outcome = Object.freeze({
        candidate,
        evidenceKey: key,
        slots: Object.freeze(outcomes.map((outcome) => Object.freeze(outcome))),
      });
    if (outcomes.some((outcome) => !outcome.itemId)) return null;
    const ids = outcomes.map((outcome) => outcome.itemId);
    return reads.map((read, slot) => {
      const itemId = ids[slot]!;
      if (itemId === read.itemId) return read;
      const a = anchors[slot]!;
      const match = { ...read.match, itemId, x: a.cx - a.icon / 2, y: a.cy - a.icon / 2, edge: a.icon };
      return { ...read, itemId, tier: tiers[itemId] ?? 0, match, ...readMarkers(img, match) };
    });
  }
}
