import { isOfferObservation, type OfferObservation } from './dropDistribution';
import type { Offer } from '../brawl/types';
import type { Item } from '../types';

export const OFFER_JOURNAL_KEY = 'brawl.offeredCards.v1';
const MAX_OBSERVATIONS = 2000;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export type OfferContext = Pick<OfferObservation, 'patch' | 'heroId' | 'round' | 'choice'>;

/** Only complete accepted offers enter this journal. Selection and recommendation events have no API here. */
export class LocalOfferJournal {
  private rows: OfferObservation[] = [];
  private session = '';
  private serial = 0;
  private latest = new Map<string, string>();
  private storage: StoragePort | undefined;
  private limit: number;
  constructor(storage?: StoragePort, limit = MAX_OBSERVATIONS) {
    this.storage = storage;
    this.limit = limit;
    try {
      const value: unknown = JSON.parse(storage?.getItem(OFFER_JOURNAL_KEY) ?? '[]');
      if (Array.isArray(value)) {
        const seen = new Set<string>();
        this.rows = value
          .filter((row): row is OfferObservation => {
            if (!isOfferObservation(row) || seen.has(row.eventId)) return false;
            seen.add(row.eventId);
            return true;
          })
          .slice(-limit);
      }
    } catch {
      /* A corrupt or unavailable local journal does not block game advice. */
    }
    this.startSession();
  }
  startSession() {
    this.session = globalThis.crypto.randomUUID();
    this.serial = 0;
    this.latest.clear();
  }
  /** A confirmed counter decrease permits even an identical rerolled set to become a new sample. */
  markReroll(context: OfferContext) {
    this.latest.delete(JSON.stringify(context));
  }
  recordAccepted(
    context: OfferContext,
    cards: OfferObservation['cards'],
    generation: OfferObservation['generation'],
    now: number,
  ) {
    const key = JSON.stringify(context);
    const signature = JSON.stringify(cards);
    if (this.latest.get(key) === signature) return false;
    const row: OfferObservation = {
      ...context,
      source: 'offered-cards',
      eventId: `${this.session}:${++this.serial}`,
      generation,
      observedAt: new Date(now).toISOString(),
      cards: cards.map((card) => ({ ...card })),
    };
    if (!isOfferObservation(row)) return false;
    this.latest.set(key, signature);
    this.rows = [...this.rows, row].slice(-this.limit);
    try {
      this.storage?.setItem(OFFER_JOURNAL_KEY, JSON.stringify(this.rows));
    } catch {
      /* Keep the in-memory evidence. */
    }
    return true;
  }
  exportObservations(): OfferObservation[] {
    return this.rows.map((row) => ({ ...row, cards: row.cards.map((card) => ({ ...card })) }));
  }
}

/** Legacy rolling-window data cannot identify the patch of a captured offer. */
export function offerPatch(
  window: { role: string; patch_id: string | null; min_unix_timestamp: number } | undefined,
): string | null {
  if (!window || window.role !== 'primary') return null;
  return window.patch_id ?? `cutoff:${window.min_unix_timestamp}`;
}

/** A choice supplies the same normal/rare tier rules to each of its three card slots. */
export function journalCards(
  offers: Offer[],
  catalog: ReadonlyMap<number, Item>,
  tiers: { normal_mod_tier: number; rare_mod_tier: number } | undefined,
): OfferObservation['cards'] | null {
  if (!tiers || offers.length !== 3) return null;
  const cards = offers.map((offer) => {
    const item = catalog.get(offer.itemId);
    return item && (item.item_tier === tiers.normal_mod_tier || item.item_tier === tiers.rare_mod_tier)
      ? {
          itemId: item.id,
          tier: item.item_tier,
          rare: item.item_tier !== tiers.normal_mod_tier,
          enhanced: !!offer.enhanced,
        }
      : null;
  });
  return cards.every((card) => card !== null) ? cards : null;
}
