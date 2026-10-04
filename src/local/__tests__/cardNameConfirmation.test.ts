import { describe, expect, it, vi } from 'vitest';
import { CardNameConfirmation, exactCardNameId } from '../cardNameConfirmation';
import type { CardRead, RGBImage } from '../../brawl/recognise';

const names = { 1: 'Superior Duration', 2: 'Tankbuster', 3: "Enchanter's Emblem" };
const img: RGBImage = { width: 2560, height: 1440, channels: 4, data: new Uint8ClampedArray(2560 * 1440 * 4) };
const reads = [1, 2, 3].map((itemId) => ({ itemId, present: true })) as CardRead[];
describe('independent names for late correction', () => {
  it('requires exact unique normalized text and high confidence, without accepting fuzzy fallback matches', () => {
    expect(exactCardNameId('superior duration', 96, names)).toBe(1);
    expect(exactCardNameId('Tankbuzter', 99, names)).toBe(0);
    expect(exactCardNameId('Tankbuster', 79, names)).toBe(0);
    expect(exactCardNameId('Tankbuster', NaN, names)).toBe(0);
    expect(exactCardNameId('ENCHANTERS EMBLEM', 94, names)).toBe(3);
    expect(exactCardNameId('Tankbuster', 99, { ...names, 4: 'TANK-BUSTER' })).toBe(0);
  });
  it('requires all three names to agree with raw slot IDs, caches unchanged evidence, and never mutates reads', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ text: 'Superior Duration', confidence: 96 })
      .mockResolvedValueOnce({ text: 'Tankbuster', confidence: 89 })
      .mockResolvedValueOnce({ text: "Enchanter's Emblem", confidence: 94 });
    const confirmation = new CardNameConfirmation(read);
    expect(await confirmation.confirm(img, reads, names, 'candidate1')).toBe(true);
    expect(await confirmation.confirm(img, reads, names, 'candidate1')).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(reads.map((r) => r.itemId)).toEqual([1, 2, 3]);
    read.mockResolvedValue({ text: 'Tankbuster', confidence: 95 });
    expect(await confirmation.confirm(img, reads, names, 'candidate2')).toBe(false);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it('discards an asynchronous confirmation after a capture reset', async () => {
    const resolvers: ((value: { text: string; confidence: number }) => void)[] = [];
    const confirmation = new CardNameConfirmation(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = confirmation.confirm(img, reads, names, 'candidate1');
    confirmation.reset();
    Object.values(names).forEach((text, slot) => resolvers[slot]!({ text, confidence: 95 }));
    expect(await pending).toBe(false);
  });
});
