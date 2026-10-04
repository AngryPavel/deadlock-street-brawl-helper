import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decodeIconIndex, readDraftScreen } from '../../brawl/recognise';
import { items, itemByName } from '../../brawl/__tests__/testData';
import { CardNameRecovery } from '../cardRecognition';
import { itemIdFromName } from '../cardNames';
import { stopItemNameOCR } from '../cardNameOcr';

const names = Object.fromEntries(items.filter((i) => !i.disabled && i.item_tier >= 1).map((i) => [i.id, i.name]));
const tiers = Object.fromEntries(items.map((i) => [i.id, i.item_tier]));
const index = decodeIconIndex(JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')));
afterAll(stopItemNameOCR);

describe('item-name recovery', () => {
  it('recovers the flashing draft supplied by the user with the zero-reroll label', async () => {
    const { data, info } = await sharp('scripts/win/frames/ultrawide-choice3-zero.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img = { width: info.width, height: info.height, data, channels: 4 as const };
    const reads = readDraftScreen(img, index, () => 0);
    const recovered = await new CardNameRecovery().recover(img, reads, names, tiers);
    expect(recovered.map((r) => [r.itemId, r.present])).toEqual(
      ['Toxic Bullets', 'Superior Duration', 'Indomitable'].map((name) => [itemByName(name).id, true]),
    );
  }, 20_000);
  it('discards OCR from a capture reset while the text was being read', async () => {
    const { data, info } = await sharp('scripts/win/frames/ultrawide-choice1.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img = { width: info.width, height: info.height, data, channels: 4 as const };
    const reads = readDraftScreen(img, { ...index, ids: [], pixels: [] }, () => 0);
    let finish!: (result: { text: string; confidence: number }) => void;
    const readText = vi.fn(
      () =>
        new Promise<{ text: string; confidence: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const recovery = new CardNameRecovery(readText);
    const partial = reads.map((r, i) => ({ ...r, present: i !== 0 }));
    const pending = recovery.recover(img, partial, names, tiers);
    recovery.reset();
    finish({ text: 'Extra Stamina', confidence: 95 });
    expect(await pending).toEqual(partial);
  });
  it('accepts punctuation/case and a clear OCR typo, rejects ambiguity and low confidence', () => {
    expect(itemIdFromName("ENCHANTER'S EMBLEM", 85, names)).toBe(itemByName("Enchanter's Emblem").id);
    expect(itemIdFromName('Monster Rounds', 20, names)).toBe(0);
    expect(itemIdFromName('Monster Roundz', 85, names)).toBe(itemByName('Monster Rounds').id);
    expect(itemIdFromName('Extra', 95, names)).toBe(0);
  });
  it('recovers all three real ultrawide names when their icons are missing from the index', async () => {
    const { data, info } = await sharp('scripts/win/frames/ultrawide-choice1.png')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img = { width: info.width, height: info.height, data, channels: 4 as const };
    const reads = readDraftScreen(img, { ...index, ids: [], pixels: [] }, () => 0);
    expect(reads.every((r) => !r.present)).toBe(true);
    const recovered = await new CardNameRecovery().recover(img, reads, names, tiers);
    expect(recovered.map((r) => [r.itemId, r.present, r.rare, r.enhanced])).toEqual([
      [itemByName('Extra Stamina').id, true, false, false],
      [itemByName('Recharging Rush').id, true, true, false],
      [itemByName('Monster Rounds').id, true, false, true],
    ]);
  }, 20_000);
});
