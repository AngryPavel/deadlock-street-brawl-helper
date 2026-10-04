import { describe, expect, it } from 'vitest';
import type { OverlayAdvice, OverlayAdviceCard } from '../../brawl/draw';
import type { CardRead } from '../../brawl/recognise';
import { cardSlotSelection } from '../cardSlotSelection';

const read = (card: string, enhanced = false, itemId = 7): CardRead => ({
  card,
  enhanced,
  itemId,
  present: true,
  rare: false,
  tier: 1,
  match: { itemId, x: 100, y: 100, edge: 100, score: 1, margin: 0.5 },
});
const ranked = (enhanced = false, score = 2, grade = 'B', itemId = 7): OverlayAdviceCard => ({
  itemId,
  enhanced,
  score,
  grade,
  name: 'Item',
  usage: 0,
  winRate: null,
  rows: [],
});
const advice = (cards: OverlayAdviceCard[]): OverlayAdvice => ({
  hero: 'Graves',
  round: 4,
  choice: 3,
  reroll: null,
  ranked: cards,
  status: 'Ready',
});

describe('card slot selection', () => {
  it('chooses exactly one stable slot when identical items are offered twice', () => {
    const cards = [ranked(), ranked(), ranked(false, 1, 'C', 8)];
    const selected = cardSlotSelection([read('left'), read('top'), read('right', false, 8)], 7, advice(cards));
    expect(selected.bestIndex).toBe(0);
    expect(selected.cards).toEqual(cards);
  });

  it('selects the stronger enhanced instance of the same ID and preserves each variant score and grade', () => {
    const enhanced = ranked(true, 5, 'S');
    const normal = ranked(false, 2, 'B');
    const selected = cardSlotSelection([read('left'), read('right', true)], 7, advice([enhanced, normal]));
    expect(selected.bestIndex).toBe(1);
    expect(selected.cards).toEqual([normal, enhanced]);
  });

  it('does not promote a different variant when the recommended instance is missing', () => {
    expect(cardSlotSelection([read('left')], 7, advice([ranked(true, 5), ranked()])).bestIndex).toBeNull();
    expect(cardSlotSelection([read('left')], 8, advice([ranked()])).bestIndex).toBeNull();
    expect(cardSlotSelection([{ ...read('left'), present: false }], 7, advice([ranked()])).bestIndex).toBeNull();
  });

  it('keeps reroll exclusive and retains a single first-match fallback for older callers without advice', () => {
    const reads = [read('left'), read('right')];
    expect(cardSlotSelection(reads, 7, advice([ranked(), ranked()]), true).bestIndex).toBeNull();
    expect(cardSlotSelection(reads, 7, null).bestIndex).toBe(0);
    expect(cardSlotSelection(reads, null, null).bestIndex).toBeNull();
  });
});
