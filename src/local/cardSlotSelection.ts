import type { OverlayAdvice, OverlayAdviceCard } from '../brawl/draw';
import type { CardRead } from '../brawl/recognise';

export interface CardSlotSelection {
  /** Index in reads, rather than item ID: equal items are still distinct offer slots. */
  bestIndex: number | null;
  cards: (OverlayAdviceCard | null)[];
}

/** Pair each ranked instance with one offered slot, keeping enhanced variants separate. */
export function cardSlotSelection(
  reads: CardRead[],
  bestId: number | null,
  advice: OverlayAdvice | null,
  reroll = false,
): CardSlotSelection {
  const used = new Set<number>();
  const ranked = advice?.ranked ?? [];
  const cards = reads.map((read) => {
    if (!read.present) return null;
    const rank = ranked.findIndex(
      (card, index) => !used.has(index) && card.itemId === read.itemId && card.enhanced === read.enhanced,
    );
    if (rank < 0) return null;
    used.add(rank);
    return ranked[rank]!;
  });
  if (reroll || bestId === null) return { bestIndex: null, cards };
  const target = ranked.find((card) => card.itemId === bestId);
  const bestIndex = target
    ? cards.findIndex((card) => card === target)
    : advice
      ? -1
      : reads.findIndex((read) => read.present && read.itemId === bestId);
  return { bestIndex: bestIndex < 0 ? null : bestIndex, cards };
}
